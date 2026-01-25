const db = require('../db');

class Refund {
  static create(data, callback) {
    const sql = `
      INSERT INTO refunds (order_id, user_id, amount, currency, method, reason, status)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
    `;
    db.query(sql, [
      data.orderId,
      data.userId,
      data.amount,
      data.currency || 'SGD',
      data.method,
      data.reason
    ], callback);
  }

  static findByOrderId(orderId, callback) {
    const sql = 'SELECT * FROM refunds WHERE order_id = ? ORDER BY createdAt DESC LIMIT 1';
    db.query(sql, [orderId], (err, rows) => {
      if (err) {
        if (err && err.code === 'ER_NO_SUCH_TABLE') {
          console.warn('Refund.findByOrderId - refunds table missing. Run the SQL migration c372_supermarketdb.sql to create it.');
          return callback(null, null);
        }
        return callback(err);
      }
      callback(null, rows && rows[0] ? rows[0] : null);
    });
  }

  static findByUserId(userId, callback) {
    const sql = `
      SELECT r.*, o.orderDate, o.totalAmount as orderTotal, o.status as orderStatus
      FROM refunds r
      JOIN orders o ON r.order_id = o.id
      WHERE r.user_id = ?
      ORDER BY r.createdAt DESC
    `;
    db.query(sql, [userId], (err, rows) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.warn('Refund.findByUserId - refunds table missing. Run the SQL migration c372_supermarketdb.sql to create it.');
          return callback(null, []);
        }
        return callback(err);
      }
      callback(null, rows || []);
    });
  }

  static findById(id, callback) {
    const sql = `
      SELECT r.*, o.orderDate, o.totalAmount as orderTotal, o.status as orderStatus,
             u.username, u.email, u.contact
      FROM refunds r
      JOIN orders o ON r.order_id = o.id
      JOIN users u ON r.user_id = u.id
      WHERE r.id = ?
    `;
    db.query(sql, [id], (err, rows) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.warn('Refund.findById - refunds table missing. Run the SQL migration c372_supermarketdb.sql to create it.');
          return callback(null, null);
        }
        return callback(err);
      }
      callback(null, rows && rows[0] ? rows[0] : null);
    });
  }

  static findAll(callback) {
    const sql = `
      SELECT r.*, o.orderDate, o.totalAmount as orderTotal, o.status as orderStatus,
             u.username, u.email, u.contact
      FROM refunds r
      JOIN orders o ON r.order_id = o.id
      JOIN users u ON r.user_id = u.id
      ORDER BY r.createdAt DESC
    `;
    db.query(sql, [], (err, rows) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.warn('Refund.findAll - refunds table missing. Run the SQL migration c372_supermarketdb.sql to create it.');
          return callback(null, []);
        }
        return callback(err);
      }
      callback(null, rows || []);
    });
  }

  static findByStatus(status, callback) {
    const sql = `
      SELECT r.*, o.orderDate, o.totalAmount as orderTotal, o.status as orderStatus,
             u.username, u.email, u.contact
      FROM refunds r
      JOIN orders o ON r.order_id = o.id
      JOIN users u ON r.user_id = u.id
      WHERE r.status = ?
      ORDER BY r.createdAt DESC
    `;
    db.query(sql, [status], (err, rows) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.warn('Refund.findByStatus - refunds table missing. Run the SQL migration c372_supermarketdb.sql to create it.');
          return callback(null, []);
        }
        return callback(err);
      }
      callback(null, rows || []);
    });
  }

  static updateStatus(id, status, adminNote, gatewayRef, callback) {
    const sql = 'UPDATE refunds SET status = ?, admin_note = ?, gateway_ref = ?, updatedAt = NOW() WHERE id = ?';
    db.query(sql, [status, adminNote, gatewayRef, id], callback);
  }

  static updateAmount(id, amount, callback) {
    const sql = 'UPDATE refunds SET amount = ?, updatedAt = NOW() WHERE id = ?';
    db.query(sql, [amount, id], callback);
  }

  static getTotalRefundedForOrder(orderId, callback) {
    const sql = `
      SELECT COALESCE(SUM(amount), 0) as totalRefunded
      FROM refunds
      WHERE order_id = ? AND status IN ('APPROVED', 'PROCESSING', 'SUCCESS')
    `;
    db.query(sql, [orderId], (err, rows) => {
      if (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.warn('Refund.getTotalRefundedForOrder - refunds table missing. Run the SQL migration c372_supermarketdb.sql to create it.');
          return callback(null, 0);
        }
        return callback(err);
      }
      callback(null, rows && rows[0] ? Number(rows[0].totalRefunded || 0) : 0);
    });
  }
}

module.exports = Refund;
