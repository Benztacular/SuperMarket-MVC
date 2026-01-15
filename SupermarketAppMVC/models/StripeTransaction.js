const db = require('../db');

class StripeTransaction {
  /**
   * Create a new Stripe transaction record
   */
  static create(data, callback) {
    const sql = `
      INSERT INTO stripe_transactions 
      (user_id, order_id, stripe_txn_id, stripe_charge_id,payment_status, amount, currency, payment_time, raw_response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.query(sql, [
      data.userId,
      data.orderId,
      data.stripeTxnId,
      data.stripeChargeId,
      data.paymentStatus || 'pending',
      data.amount,
      data.currency || 'SGD',
      data.paymentTime || new Date(),
      data.rawResponse ? JSON.stringify(data.rawResponse) : null
    ], callback);
  }

  /**
   * Find a transaction by Stripe transaction ID
   */
  static findByStripeTxnId(stripeTxnId, callback) {
    const sql = 'SELECT * FROM stripe_transactions WHERE stripe_txn_id = ? LIMIT 1';
    db.query(sql, [stripeTxnId], (err, rows) => {
      if (err) return callback(err);
      callback(null, rows && rows[0] ? rows[0] : null);
    });
  }

  /**
   * Find transactions by order ID
   */
  static findByOrderId(orderId, callback) {
    const sql = 'SELECT * FROM stripe_transactions WHERE order_id = ? ORDER BY created_at DESC';
    db.query(sql, [orderId], (err, rows) => {
      if (err) return callback(err);
      callback(null, rows || []);
    });
  }

  /**
   * Find transactions by user ID
   */
  static findByUserId(userId, callback) {
    const sql = `
      SELECT st.*, o.orderDate, o.totalAmount as orderTotal
      FROM stripe_transactions st
      JOIN orders o ON st.order_id = o.id
      WHERE st.user_id = ?
      ORDER BY st.created_at DESC
    `;
    db.query(sql, [userId], (err, rows) => {
      if (err) return callback(err);
      callback(null, rows || []);
    });
  }

  /**
   * Update transaction status
   */
  static updateStatus(id, status, rawResponse = null, callback) {
    const sql = `
      UPDATE stripe_transactions 
      SET payment_status = ?, 
          raw_response = ?,
          updated_at = NOW()
      WHERE id = ?
    `;
    
    db.query(sql, [
      status,
      rawResponse ? JSON.stringify(rawResponse) : null,
      id
    ], callback);
  }

  /**
   * Update transaction by Stripe transaction ID
   */
  static updateByStripeTxnId(stripeTxnId, status, rawResponse = null, callback) {
    const sql = `
      UPDATE stripe_transactions 
      SET payment_status = ?, 
          raw_response = ?,
          payment_time = NOW(),
          updated_at = NOW()
      WHERE stripe_txn_id = ?
    `;
    
    db.query(sql, [
      status,
      rawResponse ? JSON.stringify(rawResponse) : null,
      stripeTxnId
    ], callback);
  }

  /**
   *  Update transaction by Stripe Charge ID
   */
    static updateByStripeChargeId(stripeChargeId, status, rawResponse = null, callback) {
        const sql = `
        UPDATE stripe_transactions
        SET payment_status = ?,
        raw_response = ?,
        payment_time = NOW(),
        updated_at = NOW()
      WHERE stripe_charge_id = ?
    `;

    db.query(sql, [
      status,
      rawResponse ? JSON.stringify(rawResponse) : null,
      stripeChargeId
    ], callback);
  }
}



module.exports = StripeTransaction;
