const db = require('../db');

function create(payload, cb) {
  const sql = `INSERT INTO paypal_transactions (user_id, order_id, paypal_order_id, payer_email, amount, currency, payment_status, payment_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    payload.user_id,
    payload.order_id,
    payload.paypal_order_id,
    payload.payer_email || null,
    payload.amount || null,
    payload.currency || null,
    payload.payment_status || null,
    payload.payment_time || null
  ];
  db.query(sql, params, (err, res) => cb(err, res));
}

function listByUser(userId, cb) {
  db.query('SELECT * FROM paypal_transactions WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => cb(err, rows));
}

module.exports = { create, listByUser };
