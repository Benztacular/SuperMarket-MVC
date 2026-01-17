const stripeService = require('../services/stripe');
const db = require('../db');
const StripeTransaction = require('../models/StripeTransaction');
const Membership = require('../models/Membership');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

/**
 * Create a Stripe Payment Intent
 */
async function createPaymentIntent(req, res, next) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Compute total from cart_items
    const cartSql = `
      SELECT ci.quantity AS quantity, p.price AS price
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ?
    `;

    db.query(cartSql, [userId], async (err, rows) => {
      if (err) return next(err);
      const items = rows || [];
      if (!items.length) return res.status(400).json({ error: 'Cart empty' });

      // Include shipping fee
      const selectedShippingMethodId = req.session?.selectedShippingMethodId || null;
      const pickShipping = () => new Promise((resolve, reject) => {
        if (!selectedShippingMethodId) {
          return db.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (sErr, sRows = []) => {
            if (sErr) return reject(sErr);
            if (!sRows.length) return reject(new Error('NO_SHIP_METHOD'));
            return resolve(sRows[0]);
          });
        }
        db.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [selectedShippingMethodId], (sErr, sRows = []) => {
          if (sErr) return reject(sErr);
          if (sRows.length) return resolve(sRows[0]);
          db.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (fErr, fRows = []) => {
            if (fErr) return reject(fErr);
            if (!fRows.length) return reject(new Error('NO_SHIP_METHOD'));
            return resolve(fRows[0]);
          });
        });
      });

      let shippingFee = 0;
      try {
        const ship = await pickShipping();
        shippingFee = Number(ship.price || 0);
        if (!req.session.selectedShippingMethodId && ship.id) {
          req.session.selectedShippingMethodId = ship.id;
        }
      } catch (shipErr) {
        console.error('createPaymentIntent shipping error', shipErr);
        return res.status(400).json({ error: 'No shipping method available' });
      }

      const itemsTotal = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 0), 0);
      const total = itemsTotal + shippingFee;
      if (total <= 0) return res.status(400).json({ error: 'Invalid total' });

      // Create Stripe Payment Intent
      const paymentIntent = await stripeService.createPaymentIntent(total, {
        userId: userId.toString(),
        cartTotal: total.toString()
      });

      return res.json({ 
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: total 
      });
    });
  } catch (ex) {
    console.error('Stripe createPaymentIntent error:', ex);
    next(ex);
  }
}

/**
 * Confirm Stripe Payment and Create Order
 */
async function confirmPayment(req, res, next) {
  const util = require('util');
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { paymentIntentId } = req.body || {};
  if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId' });

  try {
    const paymentIntent = await stripeService.retrievePaymentIntent(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') return res.status(400).json({ error: 'Payment not succeeded', status: paymentIntent.status });

    const conn = db;
    const q = util.promisify(conn.query).bind(conn);
    const begin = util.promisify(conn.beginTransaction).bind(conn);
    const commit = util.promisify(conn.commit).bind(conn);
    const rollback = (cb) => { try { conn.rollback(() => cb && cb()); } catch (e) { if (cb) cb(e); } };

    await begin();

    const cartRows = (await q(`SELECT ci.id AS cart_id, ci.product_id, ci.quantity, p.price AS unit_price, p.quantity AS stock, p.productName FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? FOR UPDATE`, [userId])) || [];
    if (!cartRows.length) { rollback(() => res.status(400).json({ error: 'Cart empty' })); return; }

    for (const r of cartRows) {
      if (Number(r.quantity) > Number(r.stock)) { rollback(() => res.status(400).json({ error: `Insufficient stock for ${r.productName}` })); return; }
    }

    const addrRows = (await q('SELECT id FROM delivery_addresses WHERE user_id = ? ORDER BY (id = ?) DESC, is_default DESC, id ASC LIMIT 1', [userId, req.session?.selectedAddressId || 0])) || [];
    if (!addrRows.length) { rollback(() => res.status(400).json({ error: 'Please add a delivery address' })); return; }
    const deliveryAddressId = addrRows[0].id;

    const shipRows = (await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [req.session?.selectedShippingMethodId || 0])) || [];
    let shipRow = shipRows[0];
    if (!shipRow) {
      const fallback = (await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [])) || [];
      shipRow = fallback[0] || null;
    }
    if (!shipRow) { rollback(() => res.status(400).json({ error: 'No shipping method available' })); return; }

    const itemsTotal = cartRows.reduce((s, r) => s + Number(r.unit_price || 0) * Number(r.quantity || 0), 0);

    // membership perks
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
    const orderId = orderRes && orderRes.insertId;

    const vals = cartRows.map(r => [orderId, r.product_id, r.quantity, Number(r.unit_price || 0)]);
    const placeholders = vals.map(() => '(?, ?, ?, ?)').join(',');
    const flat = vals.flat();
    await q(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ${placeholders}`, flat);

    // decrement stock
    for (const r of cartRows) {
      await q('UPDATE products SET quantity = quantity - ? WHERE id = ?', [Number(r.quantity), r.product_id]);
    }

    await q('DELETE FROM cart_items WHERE user_id = ?', [userId]);

    // Persist stripe transaction record (best-effort)
    try {
      const amount = paymentIntent.amount / 100;
      const stripeChargeId = paymentIntent.latest_charge || (paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data[0] && paymentIntent.charges.data[0].id) || null;
      await q('INSERT INTO stripe_transactions (user_id, order_id, stripe_txn_id, stripe_charge_id, payment_status, amount, currency, payment_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())', [userId, orderId, paymentIntent.id, stripeChargeId, 'success', amount, (paymentIntent.currency || 'sgd').toUpperCase()]);
    } catch (e) { console.error('stripe tx record error', e); }

    await commit();

    // Clear session selection
    delete req.session.selectedAddressId;
    delete req.session.selectedShippingMethodId;

    return res.json({ success: true, redirect: `/payment/success?orderId=${orderId}&amount=${encodeURIComponent(total)}` });
  } catch (ex) {
    console.error('Stripe confirmPayment error:', ex);
    try { if (db && typeof db.rollback === 'function') db.rollback(() => {}); } catch (e) {}
    return next(ex);
  }
}

module.exports = {
  createPaymentIntent,
  confirmPayment
};
