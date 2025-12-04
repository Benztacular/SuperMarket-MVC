const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }

function normalize(payload) {
  return {
    user_id: payload.userId || payload.user_id || null,
    totalAmount: payload.totalAmount != null ? Number(payload.totalAmount) : (payload.total || 0),
    address: payload.address || '',
    status: payload.status || 'pending',
    createdAt: payload.createdAt || new Date()
  };
}

function create(data, cb) {
  cb = safeCb(cb);
  try {
    const p = normalize(data || {});
    if (!p.user_id) return cb(new Error('Missing user_id'));
    const sql = 'INSERT INTO orders (user_id, totalAmount, address, status, createdAt) VALUES (?, ?, ?, ?, ?)';
    const params = [p.user_id, p.totalAmount, p.address, p.status, p.createdAt];
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    db.query(sql, params, cb);
  } catch (err) { cb(err); }
}

function getById(id, cb) {
  cb = safeCb(cb);
  try {
    db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [id], cb);
  } catch (err) { cb(err); }
}

function getAll(callback) {
  const sql = `
    SELECT id AS orderId, user_id AS userId, totalAmount, status, createdAt
    FROM orders
    ORDER BY id DESC`;
  db.query(sql, [], callback);
}

function getByUser(userId, cb) {
  cb = safeCb(cb);
  try {
    db.query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [userId], cb);
  } catch (err) { cb(err); }
}

function updateById(id, data, cb) {
  cb = safeCb(cb);
  try {
    const keys = [];
    const params = [];
    if (Object.prototype.hasOwnProperty.call(data, 'userId') || Object.prototype.hasOwnProperty.call(data, 'user_id')) {
      keys.push('user_id = ?'); params.push(data.userId || data.user_id);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'totalAmount') || Object.prototype.hasOwnProperty.call(data, 'total')) {
      keys.push('totalAmount = ?'); params.push(Number(data.totalAmount != null ? data.totalAmount : data.total));
    }
    if (Object.prototype.hasOwnProperty.call(data, 'address')) {
      keys.push('address = ?'); params.push(data.address);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'status')) {
      keys.push('status = ?'); params.push(data.status);
    }
    if (!keys.length) return cb(null, { affectedRows: 0 });
    params.push(id);
    const sql = `UPDATE orders SET ${keys.join(', ')} WHERE id = ?`;
    db.query(sql, params, cb);
  } catch (err) { cb(err); }
}

function deleteById(id, cb) {
  cb = safeCb(cb);
  try {
    db.query('DELETE FROM orders WHERE id = ?', [id], cb);
  } catch (err) { cb(err); }
}

// aliases for compatibility with controllers
const add = create;
const insert = create;
const placeOrder = create;

const findAll = getAll;
const list = getAll;
const all = getAll;

const findById = getById;
const findOne = getById;
const getOne = getById;

const findByUser = getByUser;
const listByUser = getByUser;
const findAllByUser = getByUser;

const update = updateById;
const updateOrder = updateById;
const save = updateById;

const remove = deleteById;
const del = deleteById;
const destroy = deleteById;

module.exports = {
  create, add, insert, placeOrder,
  getById, findById, findOne, getOne,
  getAll, findAll, list, all,
  getByUser, findByUser, listByUser, findAllByUser,
  updateById, update, updateOrder, save,
  deleteById, delete: deleteById, remove, del, destroy
};

module.exports.create = function(payload, callback) {
  const createdAt = payload.createdAt || new Date();
  const sql = 'INSERT INTO orders (user_id, totalAmount, createdAt) VALUES (?, ?, ?)';
  db.query(sql, [payload.userId, payload.totalAmount, createdAt], callback);
};

// updateStatus: change order status
function updateStatus(orderId, status, callback) {
  const sql = 'UPDATE orders SET status = ? WHERE id = ?';
  db.query(sql, [status, orderId], callback);
}

// export additions (merge with existing exports)
module.exports = {
  // ...existing exported functions (keep them)...
  // ensure new functions are exported alongside existing
  getAll,
  updateStatus,
  // ...existing code...
};