const services = require('../services/nets');
const NetsTxn = require('../models/NetsTransaction');
const Wallet = require('../models/Wallet');
const axios = require('axios');
const db = require('../db');
const Membership = require('../models/Membership');

// In-memory store for txn statuses and active SSE clients
const txnStatusMap = new Map();
const sseClients = new Map();

function extractTxnRef(data = {}) {
  const lower = Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k || '').toLowerCase(), v]));
  return (
    data.txn_retrieval_ref || data.txnRetrievalRef || data.txn_retrieval || data.txnRetrieval ||
    data.txn_ref || data.txnRef || data.txn_id || data.txnId || data.rrn || data.txn ||
    lower.txn_retrieval_ref || lower.txnretrievalref || lower.txn_retrieval || lower.txnretrieval ||
    lower.txn_ref || lower.txnref || lower.txn_id || lower.txnid || lower.rrn || lower.stan ||
    ''
  );
}

function notifyClients(txnRetrievalRef, payload) {
  let clients = sseClients.get(txnRetrievalRef) || [];
  console.log('[NETS] notifyClients called', { txnRetrievalRef, payload, clientsFound: clients.length });

  // If no clients registered for this exact reference, try to extract txn from payload.redirect
  if ((!clients || clients.length === 0) && payload && payload.redirect) {
    try {
      const m = String(payload.redirect).match(/[?&](txn_retrieval_ref|txn|txn_retrieval)=([^&]+)/i);
      const txnFromRedirect = m ? decodeURIComponent(m[2]) : null;
      if (txnFromRedirect) {
        clients = sseClients.get(txnFromRedirect) || [];
        console.log('[NETS] notifyClients - fallback to txn from redirect', { txnFromRedirect, clientsFound: clients.length });
        txnRetrievalRef = txnFromRedirect; // update for deletion below
      }
    } catch (e) { console.error('[NETS] notifyClients fallback parse error', e); }
  }

  clients.forEach((res) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      // close connection on final states
      if (payload.success || payload.fail) {
        try { res.end(); } catch (e) {}
      }
    } catch (e) { console.error('[NETS] notifyClients write error', e); }
  });
  if (payload.success || payload.fail) {
    sseClients.delete(txnRetrievalRef);
  }

  // If still no clients were found/notified, broadcast to all connected SSE clients as a last-resort fallback
  if ((!clients || clients.length === 0)) {
    try {
      console.log('[NETS] notifyClients - no matching clients, broadcasting to all as fallback');
      for (const [ref, arr] of sseClients.entries()) {
        arr.forEach((res) => {
          try {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            if (payload.success || payload.fail) {
              try { res.end(); } catch (e) {}
            }
          } catch (e) { console.error('[NETS] broadcast write error', e); }
        });
        if (payload.success || payload.fail) sseClients.delete(ref);
      }
    } catch (e) { console.error('[NETS] notifyClients broadcast error', e); }
  }
}

exports.createQr = (req, res, next) => {
  // Delegate to service which renders the QR view on success
  return services.generateQrCode(req, res, next);
};

// Helper function to create order from cart when NETS payment succeeds
function createOrderFromCart(userId, txnRetrievalRef, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options || {};

  const conn = db;
  const util = require('util');
  const q = util.promisify(conn.query).bind(conn);
  const begin = util.promisify(conn.beginTransaction).bind(conn);
  const commit = util.promisify(conn.commit).bind(conn);
  const rollback = async (err) => { try { conn.rollback(() => {}); } catch (e) {} return err; };

  (async () => {
    try {
      await begin();

      const cartRows = (await q(`SELECT ci.id AS cart_id, ci.product_id, ci.quantity, p.price AS unit_price, p.quantity AS stock, p.productName FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? FOR UPDATE`, [userId])) || [];
      if (!cartRows.length) throw new Error('Cart empty');
      const insufficient = cartRows.find(r => Number(r.quantity) > Number(r.stock));
      if (insufficient) throw new Error(`Insufficient stock for ${insufficient.productName}`);

      const addrRows = (await q('SELECT id FROM delivery_addresses WHERE user_id = ? ORDER BY is_default DESC, id ASC LIMIT 1', [userId])) || [];
      if (!addrRows.length) throw new Error('No delivery address found');
      const deliveryAddressId = addrRows[0].id;

      const standardPrice = 4.50;
      let shipRow = null;
      if (options.selectedShippingMethodId) {
        const sRows = await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [options.selectedShippingMethodId]);
        if (sRows && sRows.length) shipRow = sRows[0];
      }
      if (!shipRow) {
        const std = await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 AND price = ? LIMIT 1', [standardPrice]);
        if (std && std.length) shipRow = std[0];
      }
      if (!shipRow) {
        const first = await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', []);
        shipRow = (first && first[0]) || null;
      }
      if (!shipRow) throw new Error('No shipping method available');

      const itemsTotal = cartRows.reduce((s, r) => s + Number(r.unit_price || 0) * Number(r.quantity || 0), 0);
      const membership = await new Promise((resolve) => Membership.getUserMembership(userId, (e, m) => resolve(m || { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 })));

      let appliedShippingFee = Number(shipRow.price || 0);
      const methodName = String(shipRow?.method_name || '').toLowerCase();
      const isStandard = methodName.includes('standard');
      const isPriority = methodName.includes('priority');
      if (isStandard && (membership.free_standard_delivery || (itemsTotal >= Number(membership.free_delivery_threshold || 0)))) appliedShippingFee = 0;
      if (isPriority && Number(membership.priority_delivery_discount || 0) > 0) appliedShippingFee = Math.max(0, appliedShippingFee - Number(membership.priority_delivery_discount || 0));

      let discountAmount = 0;
      const discThresh = Number(membership.discount_threshold || 0);
      const discPercent = Number(membership.discount_percent || 0);
      if (discPercent > 0 && itemsTotal >= discThresh) discountAmount = Number((itemsTotal * (discPercent / 100)).toFixed(2));

      const total = Number((itemsTotal + appliedShippingFee - discountAmount).toFixed(2));

      const orderRes = await q('INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, NOW(), ?, ?, NOW())', [userId, deliveryAddressId, shipRow.id, appliedShippingFee, total, 'Paid']);
      const orderId = orderRes.insertId;

      if (cartRows.length) {
        const vals = cartRows.map(r => [orderId, r.product_id, r.quantity, Number(r.unit_price || 0)]);
        const placeholders = vals.map(() => '(?, ?, ?, ?)').join(',');
        await q(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ${placeholders}`, vals.flat());
      }

      for (const r of cartRows) {
        await q('UPDATE products SET quantity = quantity - ? WHERE id = ?', [Number(r.quantity), r.product_id]);
      }

      await q('INSERT INTO nets_transactions (user_id, order_id, merchant_txn_ref, nets_txn_id, amount, currency, payment_status, payment_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())', [userId, orderId, txnRetrievalRef, txnRetrievalRef, total, 'SGD', 'SUCCESS']);
      await q('DELETE FROM cart_items WHERE user_id = ?', [userId]);

      await commit();
      return callback(null, orderId, total);
    } catch (err) {
      await rollback(err);
      return callback(err);
    }
  })();
}

exports.successPage = (req, res) => {
  const txn = extractTxnRef(req.query);
  console.log('[NETS] successPage hit', { txn, query: req.query });
  
  if (!txn) {
    console.error('[NETS] successPage - no transaction reference');
    return res.redirect('/payment/success?method=netsqr');
  }

  const userId = req.session?.user?.id || req.session?.userId;
  if (!userId) {
    console.error('[NETS] successPage - no user in session');
    return res.redirect('/login');
  }

  // If this session initiated a NETS wallet top-up, apply it and redirect to wallet
  try {
    const pendingTopUp = req.session && req.session.pendingNetsTopup;
    if (pendingTopUp && pendingTopUp.amount) {
      const topupAmount = Number(pendingTopUp.amount || 0);
      console.log('[NETS] successPage - detected pendingNetsTopup, applying wallet top-up', { txn, topupAmount });

      Wallet.findByUserId(userId, (wErr, walletRow) => {
        if (wErr || !walletRow) {
          console.error('[NETS] successPage - wallet lookup error', wErr);
          // fallback to generic success redirect
          txnStatusMap.set(txn, 'success');
          notifyClients(txn, { success: true, redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}` });
          return res.redirect(`/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}`);
        }

        Wallet.updateBalanceByUserId(userId, topupAmount, (uErr, updated) => {
          if (uErr) {
            console.error('[NETS] successPage - wallet update error', uErr);
            txnStatusMap.set(txn, 'success');
            notifyClients(txn, { success: true, redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}` });
            return res.redirect(`/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}`);
          }
          const walletId = (updated && updated.id) || (walletRow && walletRow.id) || null;
          Wallet.addTransaction({
            wallet_id: walletId,
            user_id: userId,
            type: 'TOP_UP',
            amount: topupAmount,
            reference_type: 'nets',
            reference_id: txn,
            description: `NETS top-up ${topupAmount}`
          }, (tErr) => {
            if (tErr) console.error('[NETS] successPage - addTransaction err', tErr);
            // clear pending flag from session
            try { delete req.session.pendingNetsTopup; } catch (e) {}
            NetsTxn.markStatus({ netsTxnId: txn, status: 'SUCCESS', rawResponse: req.query });
            txnStatusMap.set(txn, 'success');
            notifyClients(txn, { success: true, redirect: `/wallet` });
            return res.redirect('/wallet');
          });
        });
      });
      return;
    }
  
    // If this session initiated a membership purchase via NETS, apply membership and redirect
    try {
      const pendingMembership = req.session && req.session.pendingMembership;
      if (pendingMembership && pendingMembership.planId) {
        const planId = Number(pendingMembership.planId || 0);
        console.log('[NETS] successPage - detected pendingMembership, applying membership', { planId });
        const userId = req.session && (req.session.user && (req.session.user.id || req.session.user.user_id)) || req.session.userId;
        if (userId && planId) {
          // fetch plan info to show on success
          Membership.getPlanById(planId, (gpErr, planObj) => {
            Membership.setUserMembership(userId, planId, (mErr) => {
              try { delete req.session.pendingMembership; } catch (e) {}
              if (mErr) console.error('[NETS] apply membership error', mErr);
              NetsTxn.markStatus({ netsTxnId: txn, status: 'SUCCESS', rawResponse: req.query });
              txnStatusMap.set(txn, 'success');
              // render membership success page showing plan and amount; use txn as subscriptionId-like reference
              const period = (pendingMembership && pendingMembership.period) ? String(pendingMembership.period).toLowerCase() : (planObj && planObj.billing_period ? String(planObj.billing_period).toLowerCase() : 'monthly');
              const amount = (planObj && planObj.price) ? planObj.price : 0;
              notifyClients(txn, { success: true, redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}` });
              return res.render('membership_success', { plan: planObj || {}, period: period, amount: amount, subscriptionId: txn });
            });
          });
          return;
        }
      }
    } catch (e) { console.error('[NETS] pendingMembership handling error', e); }
  } catch (e) {
    console.error('[NETS] successPage pendingTopUp handling error', e);
  }

  // Check if order already exists for this transaction
  db.query('SELECT order_id FROM nets_transactions WHERE nets_txn_id = ? OR merchant_txn_ref = ? LIMIT 1', [txn, txn], (checkErr, checkRows) => {
    if (checkErr) {
      console.error('[NETS] successPage - error checking existing order', checkErr);
      return res.redirect('/payment/success?method=netsqr&txn=' + encodeURIComponent(txn));
    }

    if (checkRows && checkRows.length > 0 && checkRows[0].order_id) {
      // Order already created, just redirect
      const orderId = checkRows[0].order_id;
      console.log('[NETS] successPage - order already exists', orderId);
      txnStatusMap.set(txn, 'success');
      notifyClients(txn, { success: true, redirect: `/payment/success?orderId=${orderId}&method=netsqr&txn=${encodeURIComponent(txn)}` });
      return res.redirect(`/payment/success?orderId=${orderId}&method=netsqr&txn=${encodeURIComponent(txn)}`);
    }

    // Create new order (pass selected shipping method from session if present)
    createOrderFromCart(userId, txn, { selectedShippingMethodId: req.session?.selectedShippingMethodId }, (err, orderId, totalAmount) => {
      if (err) {
        console.error('[NETS] successPage - createOrderFromCart error', err);
        txnStatusMap.set(txn, 'success');
        notifyClients(txn, { success: true, redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}` });
        return res.redirect(`/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}&error=${encodeURIComponent(err.message)}`);
      }

      txnStatusMap.set(txn, 'success');
      const redirectUrl = `/payment/success?orderId=${orderId}&method=netsqr&txn=${encodeURIComponent(txn)}&amount=${encodeURIComponent(totalAmount)}`;
      notifyClients(txn, { success: true, redirect: redirectUrl });
      NetsTxn.markStatus({ netsTxnId: txn, status: 'SUCCESS', rawResponse: req.query });
      return res.redirect(redirectUrl);
    });
  });
};

exports.failPage = (req, res) => {
  const txn = extractTxnRef(req.query);
  console.log('[NETS] failPage hit', { txn, query: req.query });
  if (txn) {
    txnStatusMap.set(txn, 'fail');
    notifyClients(txn, { fail: true });
    NetsTxn.markStatus({ netsTxnId: txn, status: 'FAILED', rawResponse: req.query });
  }
  // The failure view expects a `message` variable — provide it along with txn reference
  res.render('netsTxnFailStatus', { title: 'Payment Failed', message: 'Payment failed or was cancelled', txn_retrieval_ref: txn });
};

exports.webhook = (req, res) => {
  // Accept both GET (query) and POST (body)
  const data = req.method === 'GET' ? req.query : (req.body || {});
  const txnRetrievalRef = extractTxnRef(data);
  const merchantRef = data.merchant_txn_ref || data.merchantTxnRef || data.merchant_ref || '';

  console.log('[NETS] webhook hit', {
    method: req.method,
    txnRetrievalRef,
    data
  });

  let status = 'unknown';
  // Interpret common fields
  const lower = Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k || '').toLowerCase(), v]));
  const txnStatusStr = (data.txn_status != null ? String(data.txn_status) : lower.txn_status != null ? String(lower.txn_status) : '').toUpperCase();
  const respCodeStr = (data.response_code != null ? String(data.response_code) : lower.response_code != null ? String(lower.response_code) : '').toUpperCase();
  const paymentStatusStr = (data.payment_status != null ? String(data.payment_status) : lower.payment_status != null ? String(lower.payment_status) : '').toUpperCase();
  if (txnStatusStr === '1' || txnStatusStr === 'SUCCESS' || txnStatusStr === 'PAID' || txnStatusStr === '00' || txnStatusStr === '0') status = 'success';
  if (respCodeStr === '00') status = 'success';
  if (respCodeStr && respCodeStr !== '00') status = 'fail';
  if (paymentStatusStr === 'SUCCESS') status = 'success';
  if (paymentStatusStr === 'FAILED') status = 'fail';
  if (data.success === true || data.success === 'true' || data.status === 'SUCCESS') status = 'success';
  if (data.fail === true || data.fail === 'true' || data.status === 'FAILED') status = 'fail';

  if (txnRetrievalRef) {
    const payload = {};
    if (status === 'success') {
      txnStatusMap.set(txnRetrievalRef, 'success');
      payload.success = true;
      payload.redirect = `/payment/success?method=netsqr&txn=${encodeURIComponent(txnRetrievalRef || '')}`;
    } else if (status === 'fail') {
      txnStatusMap.set(txnRetrievalRef, 'fail');
      payload.fail = true;
    } else {
      txnStatusMap.set(txnRetrievalRef, 'pending');
      payload.pending = true;
    }
    NetsTxn.markStatus({
      netsTxnId: txnRetrievalRef,
      merchantRef,
      status: status === 'success' ? 'SUCCESS' : (status === 'fail' ? 'FAILED' : 'PENDING'),
      rawResponse: data
    });
    notifyClients(txnRetrievalRef, payload);
  }

  res.status(200).send('OK');
};

exports.sseStatus = (req, res) => {
  const txnRetrievalRef = req.params.txnRetrievalRef;
  if (!txnRetrievalRef) return res.status(400).send('Missing txnRetrievalRef');

  // Setup SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');

  // If we already have a final status, send immediately
  const status = txnStatusMap.get(txnRetrievalRef);
  if (status === 'success') {
    res.write(`data: ${JSON.stringify({ success: true, redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txnRetrievalRef)}` })}\n\n`);
    return res.end();
  }
  if (status === 'fail') {
    res.write(`data: ${JSON.stringify({ fail: true, redirect: `/nets-qr/fail?txn_retrieval_ref=${encodeURIComponent(txnRetrievalRef)}` })}\n\n`);
    return res.end();
  }

  // Register client
  const clients = sseClients.get(txnRetrievalRef) || [];
  clients.push(res);
  sseClients.set(txnRetrievalRef, clients);
  console.log('[NETS] SSE client registered for', txnRetrievalRef, 'totalClients:', (sseClients.get(txnRetrievalRef) || []).length);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (e) {}
  }, 15000);

  // Timeout after 6 minutes
  const timeout = setTimeout(() => {
    try {
      res.write(`data: ${JSON.stringify({ fail: true })}\n\n`);
    } catch (e) {}
    try { res.end(); } catch (e) {}
    clearInterval(heartbeat);
    const arr = sseClients.get(txnRetrievalRef) || [];
    sseClients.set(txnRetrievalRef, arr.filter(r => r !== res));
  }, 6 * 60 * 1000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    const arr = sseClients.get(txnRetrievalRef) || [];
    sseClients.set(txnRetrievalRef, arr.filter(r => r !== res));
  });
};

// Pollable endpoint for clients to query transaction status (fallback when SSE doesn't arrive)
exports.queryStatus = (req, res) => {
  const txn = req.params.txn;
  if (!txn) return res.status(400).json({ error: 'Missing txn' });

  // 1) Check in-memory status
  const status = txnStatusMap.get(txn);
  if (status === 'success') return res.json({ status: 'success', redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}` });
  if (status === 'fail') return res.json({ status: 'fail' });

  // 2) Check DB for recorded nets_transactions
  try {
    const db = require('../db');
    const sql = 'SELECT payment_status, nets_txn_id, merchant_txn_ref FROM nets_transactions WHERE nets_txn_id = ? OR merchant_txn_ref = ? LIMIT 1';
    db.query(sql, [txn, txn], (err, rows) => {
      if (err) {
        console.error('[NETS] queryStatus db error', err);
        return res.status(500).json({ error: 'DB error' });
      }
      const row = rows && rows[0];
      if (row && row.payment_status) {
        const st = String(row.payment_status || '').toLowerCase();
        if (st === 'success' || st === 'succeeded' || st === 'completed') return res.json({ status: 'success', redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}` });
        if (st === 'failed' || st === 'failed' || st === 'failed') return res.json({ status: 'fail' });
        return res.json({ status: 'pending' });
      }

      // 3) No information yet
      return res.json({ status: 'pending' });
    });
  } catch (e) {
    console.error('[NETS] queryStatus unexpected error', e);
    return res.status(500).json({ error: 'server error' });
  }
};

// Dev helper: trigger a fake webhook-style update for a txnRetrievalRef
exports.debugTrigger = (req, res) => {
  const txn = req.method === 'GET' ? (req.query.txn || req.query.txn_retrieval_ref || req.query.rrn) : (req.body && (req.body.txn || req.body.txn_retrieval_ref || req.body.rrn));
  const status = (req.query.status || req.body?.status || 'success').toString().toLowerCase();
  if (!txn) return res.status(400).send('Missing txn parameter (txn or txn_retrieval_ref or rrn)');

  if (status === 'success') {
    txnStatusMap.set(txn, 'success');
    const payload = { success: true, redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txn)}` };
    try { NetsTxn.markStatus({ netsTxnId: txn, status: 'SUCCESS', rawResponse: { debug: true, txn } }); } catch (e) { console.error('debug markStatus err', e); }
    notifyClients(txn, payload);
    return res.json({ ok: true, triggered: payload });
  }

  if (status === 'fail') {
    txnStatusMap.set(txn, 'fail');
    const payload = { fail: true };
    try { NetsTxn.markStatus({ netsTxnId: txn, status: 'FAILED', rawResponse: { debug: true, txn } }); } catch (e) { console.error('debug markStatus err', e); }
    notifyClients(txn, payload);
    return res.json({ ok: true, triggered: payload });
  }

  return res.status(400).json({ ok: false, message: 'Unsupported status' });
};

// SSE endpoint with polling to NETS query API
exports.ssePollingStatus = async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const txnRetrievalRef = req.params.txnRetrievalRef;
  const userId = req.session?.user?.id || req.session?.userId;
  
  if (!userId) {
    res.write(`data: ${JSON.stringify({ error: 'Not authenticated' })}\n\n`);
    return res.end();
  }

  let pollCount = 0;
  const maxPolls = 60; // 5 minutes if polling every 5s
  let frontendTimeoutStatus = 0;
  let orderCreated = false;

  const interval = setInterval(async () => {
    pollCount++;

    try {
      // Call the NETS query API
      const response = await axios.post(
        'https://sandbox.nets.openapipaas.com/api/v1/common/payments/nets-qr/query',
        { txn_retrieval_ref: txnRetrievalRef, frontend_timeout_status: frontendTimeoutStatus },
        {
          headers: {
            'api-key': process.env.API_KEY,
            'project-id': process.env.PROJECT_ID,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log("Polling response:", response.data);
      // Send the full response to the frontend
      res.write(`data: ${JSON.stringify(response.data)}\n\n`);
    
      const resData = response.data.result.data;

      // Decide when to end polling and close the connection
      //Check if payment is successful
      if (resData.response_code == "00" && resData.txn_status === 1) {
        clearInterval(interval);
        
        // Create order if not already created
            if (!orderCreated) {
              orderCreated = true;

              // If this session initiated a wallet top-up, apply it instead of creating an order
              const pendingTopUp = req.session && req.session.pendingNetsTopup;
              if (pendingTopUp && pendingTopUp.amount) {
                const topupAmount = Number(pendingTopUp.amount || 0);
                // perform wallet update and add a TOP_UP transaction
                Wallet.findByUserId(userId, (wErr, walletRow) => {
                  if (wErr || !walletRow) {
                    console.error('[NETS] ssePollingStatus - wallet lookup error', wErr);
                    // fallback: notify frontend to redirect to generic success
                    res.write(`data: ${JSON.stringify({ success: true, redirect: `/wallet` })}\n\n`);
                    res.end();
                    return;
                  }
                  Wallet.updateBalanceByUserId(userId, topupAmount, (uErr, updated) => {
                    if (uErr) {
                      console.error('[NETS] ssePollingStatus - wallet update error', uErr);
                      res.write(`data: ${JSON.stringify({ success: true, redirect: `/wallet` })}\n\n`);
                      res.end();
                      return;
                    }
                    const walletId = (updated && updated.id) || (walletRow && walletRow.id) || null;
                    Wallet.addTransaction({
                      wallet_id: walletId,
                      user_id: userId,
                      type: 'TOP_UP',
                      amount: topupAmount,
                      reference_type: 'nets',
                      reference_id: txnRetrievalRef,
                      description: `NETS top-up ${topupAmount}`
                    }, (tErr) => {
                      if (tErr) console.error('[NETS] ssePollingStatus - addTransaction err', tErr);
                      // clear pending flag from session
                      try { delete req.session.pendingNetsTopup; } catch (e) {}
                      // mark nets txn status and notify frontend to redirect to wallet with success
                      NetsTxn.markStatus({ netsTxnId: txnRetrievalRef, status: 'SUCCESS', rawResponse: resData });
                      const redirectUrl = `/wallet`;
                      res.write(`data: ${JSON.stringify({ success: true, redirect: redirectUrl })}\n\n`);
                      res.end();
                    });
                  });
                });
              } else {
                // Check if order already exists
                db.query('SELECT order_id FROM nets_transactions WHERE nets_txn_id = ? OR merchant_txn_ref = ? LIMIT 1', 
                  [txnRetrievalRef, txnRetrievalRef], 
                  (checkErr, checkRows) => {
                    if (!checkErr && checkRows && checkRows.length > 0 && checkRows[0].order_id) {
                      // Order already exists
                      const orderId = checkRows[0].order_id;
                      console.log('[NETS] ssePollingStatus - order already exists', orderId);
                      const redirectUrl = `/payment/success?orderId=${orderId}&method=netsqr&txn=${encodeURIComponent(txnRetrievalRef)}`;
                      res.write(`data: ${JSON.stringify({ success: true, redirect: redirectUrl })}\n\n`);
                      res.end();
                    } else {
                      // Create new order (use session-selected shipping method if available)
                      createOrderFromCart(userId, txnRetrievalRef, { selectedShippingMethodId: req.session?.selectedShippingMethodId }, (err, orderId, totalAmount) => {
                        if (err) {
                          console.error('[NETS] ssePollingStatus - createOrderFromCart error', err);
                          res.write(`data: ${JSON.stringify({ success: true, error: err.message, redirect: `/payment/success?method=netsqr&txn=${encodeURIComponent(txnRetrievalRef)}` })}\n\n`);
                        } else {
                          console.log('[NETS] ssePollingStatus - order created', orderId);
                          const redirectUrl = `/payment/success?orderId=${orderId}&method=netsqr&txn=${encodeURIComponent(txnRetrievalRef)}&amount=${encodeURIComponent(totalAmount)}`;
                          res.write(`data: ${JSON.stringify({ success: true, redirect: redirectUrl })}\n\n`);
                        }
                        res.end();
                      });
                    }
                  }
                );
              }
            } else {
              res.write(`data: ${JSON.stringify({ success: true })}\n\n`);
              res.end();
            }
      } else if (frontendTimeoutStatus == 1 && resData && (resData.response_code !== "00" || resData.txn_status === 2)) {
        // Payment failure: send a fail message
        clearInterval(interval);
        res.write(`data: ${JSON.stringify({ fail: true, ...resData })}\n\n`);
        res.end();
      }

    } catch (err) {
      clearInterval(interval);
      console.error('[NETS] ssePollingStatus error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }

    // Timeout
    if (pollCount >= maxPolls) {
      clearInterval(interval);
      frontendTimeoutStatus = 1;
      res.write(`data: ${JSON.stringify({ fail: true, error: "Timeout" })}\n\n`);
      res.end();
    }
  }, 5000);

  req.on('close', () => {
    clearInterval(interval);
  });
};

module.exports = exports;
