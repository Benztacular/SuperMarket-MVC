const paypalService = require('../services/paypal');
const db = require('../db');
const PaypalTransaction = require('../models/PaypalTransaction');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

async function createOrder(req, res, next) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // compute total from cart_items
    db.query(
      `SELECT ci.quantity AS quantity, p.price AS price
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = ?`,
      [userId],
      async (err, rows) => {
        if (err) return next(err);
        const items = rows || [];
        if (!items.length) return res.status(400).json({ error: 'Cart empty' });
        const total = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 0), 0);
        if (total <= 0) return res.status(400).json({ error: 'Invalid total' });

        const order = await paypalService.createOrder(total);
        return res.json({ orderID: order.id, amount: total });
      }
    );
  } catch (ex) {
    next(ex);
  }
}

async function captureOrder(req, res, next) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'Missing orderID' });

    const capture = await paypalService.captureOrder(orderID);

    // attempt to extract capture info
    const captureUnit = (capture.purchase_units && capture.purchase_units[0]) || {};
    const payments = (captureUnit.payments && captureUnit.payments.captures && captureUnit.payments.captures[0]) || {};
    const status = payments.status || capture.status || null;

    if (!status || !/COMPLET|COMPLETED/i.test(String(status))) {
      return res.status(400).json({ error: 'Payment not completed', detail: capture });
    }

    // Create local order and records in a transaction
    const conn = db;
    conn.beginTransaction((txErr) => {
      if (txErr) return next(txErr);

      const cartSql = `
        SELECT ci.id AS cart_id, ci.product_id, ci.quantity,
               p.price AS unit_price, p.quantity AS stock, p.productName
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.user_id = ?
        FOR UPDATE
      `;
      conn.query(cartSql, [userId], (cErr, cartRows) => {
        if (cErr) return conn.rollback(() => next(cErr));
        if (!cartRows || cartRows.length === 0) return conn.rollback(() => res.status(400).json({ error: 'Cart empty' }));

        for (const r of cartRows) {
          if (Number(r.quantity) > Number(r.stock)) return conn.rollback(() => res.status(400).json({ error: `Insufficient stock for ${r.productName}` }));
        }

        const total = cartRows.reduce((s, r) => s + Number(r.unit_price || 0) * Number(r.quantity || 0), 0);

        conn.query('INSERT INTO orders (user_id, orderDate, totalAmount, status, createdAt) VALUES (?, NOW(), ?, ?, NOW())', [userId, total, 'Paid'], (oErr, oRes) => {
          if (oErr) return conn.rollback(() => next(oErr));
          const orderId = oRes.insertId;

          const vals = cartRows.map(r => [orderId, r.product_id, r.quantity, Number(r.unit_price || 0)]);
          const placeholders = vals.map(() => '(?, ?, ?, ?)').join(',');
          const flat = vals.flat();
          conn.query(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ${placeholders}`, flat, (oiErr) => {
            if (oiErr) return conn.rollback(() => next(oiErr));

            const updates = cartRows.map(r => new Promise((resolve, reject) => {
              conn.query('UPDATE products SET quantity = quantity - ? WHERE id = ?', [Number(r.quantity), r.product_id], (uErr) => uErr ? reject(uErr) : resolve());
            }));

            Promise.all(updates)
              .then(() => {
                conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (dErr) => {
                  if (dErr) return conn.rollback(() => next(dErr));

                  // persist paypal transaction
                  const payerEmail = (capture.payer && capture.payer.email_address) || null;
                  const amount = (payments.amount && payments.amount.value) || String(total);
                  const currency = (payments.amount && payments.amount.currency_code) || (process.env.PAYPAL_CURRENCY || 'SGD');
                  const paymentStatus = payments.status || capture.status || 'COMPLETED';
                  const paymentTime = (payments && payments.update_time) ? new Date(payments.update_time) : new Date();

                  conn.query('INSERT INTO paypal_transactions (user_id, order_id, paypal_order_id, payer_email, amount, currency, payment_status, payment_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [userId, orderId, orderID, payerEmail, amount, currency, paymentStatus, paymentTime], (ptErr) => {
                      if (ptErr) return conn.rollback(() => next(ptErr));

                      conn.commit((cmErr) => {
                            if (cmErr) return conn.rollback(() => next(cmErr));
                            // prefer a dedicated payment success page that shows masked method and CTA
                            const txnId = (payments && payments.id) ? payments.id : orderID;
                            const encodedTxn = encodeURIComponent(txnId || '');
                            const encodedAmount = encodeURIComponent(amount || total || '');
                            return res.json({ success: true, redirect: `/payment/success?orderId=${orderId}&method=paypal&txn=${encodedTxn}&amount=${encodedAmount}` });
                          });
                    });
                });
              })
              .catch((decErr) => conn.rollback(() => next(decErr)));
          });
        });
      });
    });
  } catch (ex) {
    next(ex);
  }
}

module.exports = { createOrder, captureOrder };
