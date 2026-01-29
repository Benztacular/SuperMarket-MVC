const axios = require('axios');
const db = require('../db');
const util = require('util');
const Membership = require('../models/Membership');
const NetsTransaction = require('../models/NetsTransaction');

async function computeServerCartTotal(req) {
  let cartTotal = null;
  try {
    const userId = req.session && (req.session.user && (req.session.user.id || req.session.user.user_id)) || req.session?.userId || null;
    if (!userId) return null;

    const q = util.promisify(db.query).bind(db);
    const cartRows = await q(
      `SELECT ci.product_id, ci.quantity, p.price AS unit_price, p.quantity AS stock
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = ? AND COALESCE(ci.selected, 1) = 1`,
      [userId]
    ) || [];

    const itemsTotal = (cartRows || []).reduce((s, r) => s + Number(r.unit_price || 0) * Number(r.quantity || 0), 0);

    const membership = await new Promise((resolve) => {
      try {
        Membership.getUserMembership(userId, (e, m) => resolve(m || { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 }));
      } catch (err) { resolve({ plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 }); }
    });

    // determine shipping fee
    let appliedShippingFee = 0;
    const selectedShippingMethodId = req.session && req.session.selectedShippingMethodId ? req.session.selectedShippingMethodId : null;
    if (selectedShippingMethodId) {
      const sRows = await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [selectedShippingMethodId]);
      if (sRows && sRows[0]) appliedShippingFee = Number(sRows[0].price || 0);
    }
    if (!appliedShippingFee) {
      const std = await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', []);
      appliedShippingFee = (std && std[0] && Number(std[0].price || 0)) || 0;
    }

    // Apply membership shipping perks
    const methodRow = selectedShippingMethodId ? (await q('SELECT method_name FROM shipping_methods WHERE id = ? LIMIT 1', [selectedShippingMethodId]) || [])[0] : null;
    const methodName = String(methodRow?.method_name || '').toLowerCase();
    const isStandard = methodName.includes('standard');
    const isPriority = methodName.includes('priority');
    if (isStandard && (membership.free_standard_delivery || (itemsTotal >= Number(membership.free_delivery_threshold || 0)))) appliedShippingFee = 0;
    if (isPriority && Number(membership.priority_delivery_discount || 0) > 0) appliedShippingFee = Math.max(0, appliedShippingFee - Number(membership.priority_delivery_discount || 0));

    // membership discount on items
    let discountAmount = 0;
    const discThresh = Number(membership.discount_threshold || 0);
    const discPercent = Number(membership.discount_percent || 0);
    if (discPercent > 0 && itemsTotal >= discThresh) discountAmount = Number((itemsTotal * (discPercent / 100)).toFixed(2));

    const appliedCoupon = req.session && req.session.appliedCoupon ? req.session.appliedCoupon : null;
    const couponDiscount = Number((appliedCoupon && Number(appliedCoupon.discount || 0)) || 0);

    cartTotal = Number((itemsTotal + appliedShippingFee - discountAmount - couponDiscount).toFixed(2));
  } catch (e) {
    console.error('Failed to compute server-side cart total for NETS QR', e);
    cartTotal = null;
  }
  return cartTotal;
}

exports.generateQrCode = async (req, res) => {
  // Prefer server-computed total; but if server total is null or zero and
  // a client-supplied membership amount exists, use the client value.
  let cartTotal = await computeServerCartTotal(req);
  const fromBody = req.body && (req.body.cartTotal || req.body.total);
  // If this request is for a pending membership purchase, prefer the
  // client-supplied / controller-provided plan amount to avoid including
  // shipping defaults (membership is not a physical shipment).
  const isMembershipFlow = req.session && req.session.pendingMembership;
  if (isMembershipFlow && fromBody != null && Number(fromBody) > 0) {
    cartTotal = Number(fromBody);
  } else if (cartTotal == null || (Number(cartTotal || 0) <= 0 && fromBody != null && Number(fromBody) > 0)) {
    cartTotal = fromBody != null ? Number(fromBody) : (cartTotal == null ? 0 : Number(cartTotal || 0));
  }
  cartTotal = Number(cartTotal || 0);

  try {
    const requestBody = {
      txn_id: 'sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b',
      amt_in_dollars: cartTotal,
      notify_mobile: 0,
    };

    const response = await axios.post(
      'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/request',
      requestBody,
      {
        headers: {
          'api-key': process.env.API_KEY,
          'project-id': process.env.PROJECT_ID,
        },
      }
    );

    const getCourseInitIdParam = () => {
      try {
        require.resolve('./../course_init_id');
        const { courseInitId } = require('../course_init_id');
        return courseInitId ? `${courseInitId}` : '';
      } catch (error) {
        return '';
      }
    };

    const qrData = response?.data?.result?.data;
    if (qrData && qrData.response_code === '00' && qrData.txn_status === 1 && qrData.qr_code) {
      const txnRetrievalRef = qrData.txn_retrieval_ref;
      const courseInitId = getCourseInitIdParam();
      const webhookUrl = `https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets/webhook?txn_retrieval_ref=${txnRetrievalRef}&course_init_id=${courseInitId}`;

      return res.render('netsQr', {
        total: cartTotal,
        title: 'Scan to Pay',
        qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
        txnRetrievalRef: txnRetrievalRef,
        courseInitId: courseInitId,
        networkCode: qrData.network_status,
        timer: 300,
        webhookUrl: webhookUrl,
        fullNetsResponse: response.data,
        apiKey: process.env.API_KEY,
        projectId: process.env.PROJECT_ID,
      });
    }

    // Handle partial or failed responses
    let errorMsg = 'An error occurred while generating the QR code.';
    if (qrData && qrData.network_status !== 0) {
      errorMsg = qrData.error_message || 'Transaction failed. Please try again.';
    }
    return res.render('netsQrFail', {
      title: 'Error',
      responseCode: (qrData && qrData.response_code) || 'N.A.',
      instructions: (qrData && qrData.instruction) || '',
      errorMsg: errorMsg,
    });
  } catch (error) {
    console.error('Error in generateQrCode:', error && error.message ? error.message : error);
    return res.redirect('/nets-qr/fail');
  }
};

/**
 * Attempt to refund a NETS transaction for the given orderId and amount.
 * Returns an object { success: boolean, gatewayRef, rawResponse, error }
 */
exports.refundNetsTransaction = async (orderId, amount) => {
  try {
    const q = util.promisify(db.query).bind(db);
    // Find the latest nets transaction for the order
    const rows = await q('SELECT * FROM nets_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
    const txn = (rows && rows[0]) || null;
    if (!txn) {
      return { success: false, error: new Error('No NETS transaction found for this order') };
    }

    const txnRetrievalRef = txn.nets_txn_id || txn.merchant_txn_ref;
    if (!txnRetrievalRef) {
      return { success: false, error: new Error('NETS transaction lacks nets_txn_id / merchant_txn_ref') };
    }

    // Build refund request - NETS API may differ in production, this is a best-effort endpoint and payload.
    const endpoint = process.env.NETS_REFUND_ENDPOINT || 'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets/refund';
    const requestBody = {
      txn_retrieval_ref: txnRetrievalRef,
      amt_in_dollars: Number(amount) || 0,
      reason: `Refund for order ${orderId}`
    };

    const response = await axios.post(endpoint, requestBody, {
      headers: {
        'api-key': process.env.API_KEY,
        'project-id': process.env.PROJECT_ID,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });

    const respData = response && response.data ? response.data : null;

    // Persist the response into nets_transactions via markStatus so webhooks are traceable
    try {
      NetsTransaction.markStatus({ merchantRef: txn.merchant_txn_ref, netsTxnId: txn.nets_txn_id, status: 'REFUNDED', rawResponse: respData, amount }, () => {});
    } catch (e) {
      console.error('Failed to persist NETS refund response:', e);
    }

    // Interpret success heuristically
    const success = respData && (respData.result?.status === '00' || respData.result?.response_code === '00' || respData.result?.txn_status === 2 || respData.success === true);
    const gatewayRef = (respData && (respData.result && respData.result.refund_id)) || respData && respData.refund_id || `nets_refund_${txnRetrievalRef}_${Date.now()}`;

    return { success: !!success, gatewayRef, rawResponse: respData };
  } catch (err) {
    console.error('refundNetsTransaction error:', err && err.message ? err.message : err);
    return { success: false, error: err };
  }
};

// Export helper for reuse (e.g. Stripe amount computations)
exports.computeServerCartTotal = computeServerCartTotal;
