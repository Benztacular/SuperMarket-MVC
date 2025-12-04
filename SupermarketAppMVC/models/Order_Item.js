const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }

function normalize(payload) {
  return {
    order_id: payload.orderId || payload.order_id || null,
    product_id: payload.productId || payload.product_id || null,
    quantity: Number(payload.quantity || payload.qty || 0),
    price: payload.price != null ? Number(payload.price) : null,
    createdAt: payload.createdAt || new Date()
  };
}

function create(data, cb) {
  cb = safeCb(cb);
  try {
    const p = normalize(data || {});
    if (!p.order_id || !p.product_id) return cb(new Error('Missing order_id or product_id'));
    const sql = 'INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES (?, ?, ?, ?, ?)';
    const params = [p.order_id, p.product_id, p.quantity, p.price, p.createdAt];
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    db.query(sql, params, cb);
  } catch (err) { cb(err); }
}

function getByOrder(orderId, cb) {
  cb = safeCb(cb);
  try {
    const sql = `
      SELECT oi.id, oi.order_id, oi.product_id, oi.quantity, oi.price, oi.createdAt,
             p.productName, p.image
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC`;
    db.query(sql, [orderId], cb);
  } catch (err) { cb(err); }
}

function getAll(cb) {
  cb = safeCb(cb);
  try {
    db.query('SELECT * FROM order_items ORDER BY id DESC', cb);
  } catch (err) { cb(err); }
}

function getById(id, cb) {
  cb = safeCb(cb);
  try {
    db.query('SELECT * FROM order_items WHERE id = ? LIMIT 1', [id], cb);
  } catch (err) { cb(err); }
}

function updateById(id, data, cb) {
  cb = safeCb(cb);
  try {
    const keys = [];
    const params = [];
    if (Object.prototype.hasOwnProperty.call(data, 'orderId') || Object.prototype.hasOwnProperty.call(data, 'order_id')) {
      keys.push('order_id = ?'); params.push(data.orderId || data.order_id);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'productId') || Object.prototype.hasOwnProperty.call(data, 'product_id')) {
      keys.push('product_id = ?'); params.push(data.productId || data.product_id);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'quantity') || Object.prototype.hasOwnProperty.call(data, 'qty')) {
      keys.push('quantity = ?'); params.push(Number(data.quantity || data.qty));
    }
    if (Object.prototype.hasOwnProperty.call(data, 'price')) {
      keys.push('price = ?'); params.push(Number(data.price));
    }
    if (!keys.length) return cb(null, { affectedRows: 0 });
    params.push(id);
    const sql = `UPDATE order_items SET ${keys.join(', ')} WHERE id = ?`;
    db.query(sql, params, cb);
  } catch (err) { cb(err); }
}

function deleteById(id, cb) {
  cb = safeCb(cb);
  try {
    db.query('DELETE FROM order_items WHERE id = ?', [id], cb);
  } catch (err) { cb(err); }
}

// aliases
const add = create;
const insert = create;
const findAll = getAll;
const list = getAll;
const all = getAll;
const findById = getById;
const findByOrder = getByOrder;
const update = updateById;
const save = updateById;
const remove = deleteById;
const del = deleteById;
const destroy = deleteById;

module.exports = {
  create, add, insert,
  getByOrder, findByOrder,
  getAll, findAll, list, all,
  getById, findById,
  updateById, update, save,
  deleteById, delete: deleteById, remove, del, destroy
};