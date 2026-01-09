const db = require('../db');
const Review = require('../models/Review');

function ensureAnonUser(cb) {
  // find or create persistent Anonymous user
  db.query('SELECT id FROM users WHERE username = ? LIMIT 1', ['Anonymous'], (sErr, sRows) => {
    if (sErr) return cb(sErr);
    if (sRows && sRows[0]) return cb(null, sRows[0].id);
    const insert = 'INSERT INTO users (username, email, password, address, contact, role, createdAt, profileImage) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)';
    const params = ['Anonymous', 'anonymous@local', '', '', '', 'guest', 'default.png'];
    db.query(insert, params, (iErr, iRes) => {
      if (iErr) return cb(iErr);
      return cb(null, iRes.insertId);
    });
  });
}

exports.post = function (req, res, next) {
  try {
    const sessionUser = req.session && req.session.user;
    let userId = sessionUser && (sessionUser.id || sessionUser.user_id || sessionUser.userId) || req.session && req.session.userId;
    const productId = Number(req.params.id);
    const rating = Number(req.body.rating || 5);
    const text = String(req.body.review || req.body.text || req.body.comment || '').trim();

    if (!productId || !Number.isFinite(rating) || rating < 1 || rating > 5) {
      if (req.flash) req.flash('error', 'Invalid review data');
      return res.redirect(req.get('referer') || `/product/${productId}`);
    }

    const proceedWithUser = (uid) => {
      // verify user purchased product
      Review.findOrderForUserProduct(uid, productId, (oErr, orderId) => {
        if (oErr) return next(oErr);
        if (!orderId) {
          if (req.flash) req.flash('error', 'You can only review products you have purchased');
          return res.redirect(req.get('referer') || `/product/${productId}`);
        }

        Review.create({ user_id: uid, product_id: productId, order_id: orderId, rating, review: text }, (cErr) => {
          if (cErr) {
            const msg = (cErr && cErr.code === 'ER_DUP_ENTRY') ? 'You have already reviewed this purchase' : 'Failed to save review';
            if (req.flash) req.flash('error', msg);
            return res.redirect(req.get('referer') || `/product/${productId}`);
          }

          // update aggregates
          Review.aggregateForProduct(productId, (aErr, agg) => {
            if (!aErr && agg) {
              const avg = Number(agg.avgRating || 0).toFixed(2);
              const cnt = Number(agg.cnt || 0);
              db.query('UPDATE products SET averageRating = ?, reviewCount = ? WHERE id = ?', [avg, cnt, productId], () => {
                if (req.flash) req.flash('success', 'Thank you — your review has been posted');
                return res.redirect(req.get('referer') || `/product/${productId}`);
              });
            } else {
              if (req.flash) req.flash('success', 'Thank you — your review has been posted');
              return res.redirect(req.get('referer') || `/product/${productId}`);
            }
          });
        });
      });
    };

    if (userId) return proceedWithUser(userId);
    // ensure anonymous user exists then proceed
    ensureAnonUser((err, anonId) => {
      if (err) return next(err);
      return proceedWithUser(anonId);
    });
  } catch (ex) { next(ex); }
};

exports.listForProduct = function (productId, cb) {
  Review.listByProduct(productId, cb);
};

// Render a page where the user can review each item from a specific order
exports.orderReviewPage = function (req, res, next) {
  try {
    const sessionUser = req.session && req.session.user;
    const userId = (sessionUser && (sessionUser.id || sessionUser.user_id)) || req.session && req.session.userId;
    if (!userId) return res.redirect('/login');

    const orderId = req.params.id;
    // verify ownership
    db.query('SELECT id, user_id, status, createdAt FROM orders WHERE id = ? LIMIT 1', [orderId], (oErr, oRows) => {
      if (oErr) return next(oErr);
      const order = (oRows && oRows[0]) || null;
      if (!order) return res.status(404).send('Order not found');
      if (Number(order.user_id) !== Number(userId) && !(req.session.user && req.session.user.role === 'admin')) return res.status(403).send('Forbidden');

      const sql = `
        SELECT oi.product_id, oi.quantity, oi.price, p.productName, p.image,
               pr.id AS review_id, pr.rating, pr.review AS text
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN product_reviews pr ON pr.product_id = oi.product_id AND pr.order_id = oi.order_id AND pr.user_id = ?
        WHERE oi.order_id = ?`;
      db.query(sql, [userId, orderId], (iErr, items) => {
        if (iErr) return next(iErr);
        return res.render('orderReview', {
          orderId,
          items: items || [],
          user: req.session.user
        });
      });
    });
  } catch (ex) { next(ex); }
};

// Save or update a review for a product within an order (allows editing existing review)
exports.saveForOrder = function (req, res, next) {
  try {
    const sessionUser = req.session && req.session.user;
    const userId = (sessionUser && (sessionUser.id || sessionUser.user_id)) || req.session && req.session.userId;
    if (!userId) return res.redirect('/login');

    const orderId = req.params.id;
    const productId = Number(req.params.productId);
    const rating = Number(req.body.rating || 5);
    const text = String(req.body.review || req.body.text || '').trim();

    if (!productId || !orderId || !Number.isFinite(rating) || rating < 1 || rating > 5) {
      if (req.flash) req.flash('error', 'Invalid review submission');
      return res.redirect(req.get('referer') || `/orders/${orderId}/review`);
    }

    // ensure the order belongs to the user and includes the product
    db.query('SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.id = ? AND o.user_id = ? AND oi.product_id = ? LIMIT 1', [orderId, userId, productId], (chkErr, chkRows) => {
      if (chkErr) return next(chkErr);
      if (!chkRows || !chkRows.length) {
        if (req.flash) req.flash('error', 'You may only review items you purchased');
        return res.redirect(req.get('referer') || `/orders/${orderId}/review`);
      }

      const updateSql = 'UPDATE product_reviews SET rating = ?, review = ?, updatedAt = NOW() WHERE user_id = ? AND order_id = ? AND product_id = ?';
      db.query(updateSql, [rating, text || null, userId, orderId, productId], (uErr, uRes) => {
        if (uErr) return next(uErr);
        if (uRes && uRes.affectedRows > 0) {
          if (req.flash) req.flash('success', 'Your review has been updated');
          // recalc aggregates
          Review.aggregateForProduct(productId, () => res.redirect(req.get('referer') || `/orders/${orderId}/review`));
          return;
        }

        // insert new
        const insertSql = 'INSERT INTO product_reviews (user_id, product_id, order_id, rating, review, createdAt) VALUES (?, ?, ?, ?, ?, NOW())';
        db.query(insertSql, [userId, productId, orderId, rating, text || null], (iErr) => {
          if (iErr) {
            const msg = (iErr && iErr.code === 'ER_DUP_ENTRY') ? 'You have already reviewed this item' : 'Failed to save review';
            if (req.flash) req.flash('error', msg);
            return res.redirect(req.get('referer') || `/orders/${orderId}/review`);
          }
          // update aggregates then redirect
          Review.aggregateForProduct(productId, (aErr, agg) => {
            if (!aErr && agg) {
              const avg = Number(agg.avgRating || 0).toFixed(2);
              const cnt = Number(agg.cnt || 0);
              db.query('UPDATE products SET averageRating = ?, reviewCount = ? WHERE id = ?', [avg, cnt, productId], () => {
                if (req.flash) req.flash('success', 'Thank you — your review has been posted');
                return res.redirect(req.get('referer') || `/orders/${orderId}/review`);
              });
            } else {
              if (req.flash) req.flash('success', 'Thank you — your review has been posted');
              return res.redirect(req.get('referer') || `/orders/${orderId}/review`);
            }
          });
        });
      });
    });
  } catch (ex) { next(ex); }
};

module.exports = exports;
