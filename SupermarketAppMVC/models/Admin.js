const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }

function create(data, cb) {
  cb = safeCb(cb);
  try {
    const sql = 'INSERT INTO admins (username, email, password, address, contact, role, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const params = [
      data.username || null,
      data.email || null,
      data.password || null,
      data.address || '',
      data.contact || '',
      data.role || 'admin',
      data.createdAt || new Date()
    ];
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    db.query(sql, params, cb);
  } catch (err) { cb(err); }
}

function getAll(cb) {
  cb = safeCb(cb);
  try {
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    db.query('SELECT * FROM admins ORDER BY id DESC', cb);
  } catch (err) { cb(err); }
}

function getById(id, cb) {
  cb = safeCb(cb);
  try {
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    db.query('SELECT * FROM admins WHERE id = ? LIMIT 1', [id], cb);
  } catch (err) { cb(err); }
}

function getByEmail(email, cb) {
  cb = safeCb(cb);
  try {
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    db.query('SELECT * FROM admins WHERE email = ? LIMIT 1', [email], cb);
  } catch (err) { cb(err); }
}

function updateById(id, data, cb) {
  cb = safeCb(cb);
  try {
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    const keys = [];
    const params = [];
    for (const k of ['username','email','password','address','contact','role','twoFactorSecret','twoFactorEnabled']) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        keys.push(`${k} = ?`);
        params.push(data[k]);
      }
    }
    if (!keys.length) return cb(null, { affectedRows: 0 });
    params.push(id);
    const sql = `UPDATE admins SET ${keys.join(', ')} WHERE id = ?`;
    db.query(sql, params, cb);
  } catch (err) { cb(err); }
}

function deleteById(id, cb) {
  cb = safeCb(cb);
  try {
    if (!db || typeof db.query !== 'function') return cb(new Error('Database not available'));
    db.query('DELETE FROM admins WHERE id = ?', [id], cb);
  } catch (err) { cb(err); }
}

// aliases to match various controller expectations
const register = create;
const add = create;
const insert = create;
const findAll = getAll;
const list = getAll;
const all = getAll;
const findById = getById;
const findOne = getById;
const findByEmail = getByEmail;
const update = updateById;
const save = updateById;
const remove = deleteById;
const del = deleteById;
const destroy = deleteById;

module.exports = {
  create, register, add, insert,
  getAll, findAll, list, all,
  getById, findById, findOne,
  getByEmail, findByEmail,
  updateById, update, save,
  deleteById, delete: deleteById, remove, del, destroy
};

/**
 * createRegisterKey(session)
 * - stores key + expiry on session (3 minutes)
 * - logs key to server console
 */
module.exports.createRegisterKey = function (session) {
  try {
    const key = String(Math.floor(100000 + Math.random() * 900000));
    if (session) {
      session.adminRegisterKey = key;
      session.adminRegisterKeyExpires = Date.now() + 3 * 60 * 1000; // 3 minutes
    }
    // include session id or fallback to timestamp so you can correlate in logs
    const sid = (session && (session.id || session.sessionID || session.cookie && session.cookie.path)) || `ts:${Date.now()}`;
    console.log(`Admin registration key (valid 3 minutes) [session=${sid}]: ${key}`);
    return key;
  } catch (err) {
    console.warn('createRegisterKey failed:', err && err.message);
    return null;
  }
};