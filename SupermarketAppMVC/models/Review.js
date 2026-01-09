const db = require('../db');

module.exports = {
  create: function (data, cb) {
    const sql = 'INSERT INTO product_reviews (user_id, product_id, order_id, rating, review, createdAt) VALUES (?, ?, ?, ?, ?, NOW())';
    const params = [data.user_id, data.product_id, data.order_id, data.rating, data.review || null];
    db.query(sql, params, cb);
  },

  listByProduct: function (productId, cb) {
    const sql = `
      SELECT pr.id, pr.user_id, pr.product_id, pr.order_id, pr.rating, pr.review AS text, pr.createdAt,
             u.username
      FROM product_reviews pr
      LEFT JOIN users u ON u.id = pr.user_id
      WHERE pr.product_id = ?
      ORDER BY pr.createdAt DESC
    `;
    db.query(sql, [productId], (err, rows) => cb(err, rows || []));
  },

  aggregateForProduct: function (productId, cb) {
    const sql = 'SELECT AVG(rating) AS avgRating, COUNT(*) AS cnt FROM product_reviews WHERE product_id = ?';
    db.query(sql, [productId], (err, rows) => cb(err, rows && rows[0] ? rows[0] : { avgRating: 0, cnt: 0 }));
  },

  // Find a recent order id for a user that contains the product
  findOrderForUserProduct: function (userId, productId, cb) {
    const sql = `
      SELECT o.id AS order_id
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ? AND oi.product_id = ?
      ORDER BY o.createdAt DESC
      LIMIT 1
    `;
    db.query(sql, [userId, productId], (err, rows) => cb(err, rows && rows[0] ? rows[0].order_id : null));
  }
};
