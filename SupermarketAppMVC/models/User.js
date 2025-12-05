const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }

function query(sql, params, cb) {
  cb = safeCb(cb);
  try {
    if (typeof db.query === 'function') return db.query(sql, params, cb);
    if (db && db.pool && typeof db.pool.query === 'function') return db.pool.query(sql, params, cb);
    throw new Error('DB client has no query method');
  } catch (err) { cb(err); }
}

function normalizeInsert(data = {}) {
  // allow these columns to be created/updated
  const out = {};
  const allowed = ['username', 'email', 'password', 'address', 'contact', 'role', 'twoFactorSecret', 'twoFactorEnabled', 'createdAt'];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) out[k] = data[k];
  }

  // ensure contact is a trimmed string and not too long to avoid DB errors
  if (out.contact != null) {
    out.contact = String(out.contact).trim().slice(0, 100); // match DB width
    if (out.contact === '') out.contact = null;
  }

  // ensure email/username lengths are reasonable (optional)
  if (out.email) out.email = String(out.email).trim().slice(0, 255);
  if (out.username) out.username = String(out.username).trim().slice(0, 100);

  return out;
}

const User = {
  // List users (omit password by default)
  findAll(cb) {
    cb = safeCb(cb);
    query('SELECT id, username, email, address, contact, role, twoFactorEnabled FROM users ORDER BY id DESC', [], cb);
  },

  // Get user by id
  findById(id, cb) {
    cb = safeCb(cb);
    query('SELECT * FROM users WHERE id = ? LIMIT 1', [Number(id)], (err, rows) => {
      if (err) return cb(err);
      // some DB clients return rows array, some return single row
      const row = Array.isArray(rows) ? (rows[0] || null) : rows || null;
      cb(null, row);
    });
  },

  // Create user and return the created row
  create(data, cb) {
    cb = safeCb(cb);
    const row = normalizeInsert(data);
    if (!row.username || !row.email || row.password == null) {
      return cb(new Error('username, email and password are required'));
    }
    if (!row.role) row.role = (typeof row.role === 'string' && row.role) ? row.role : 'user';
    if (!row.createdAt) row.createdAt = new Date();

    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders})`;
    query(sql, cols.map(c => row[c]), (err, result) => {
      if (err) return cb(err);
      // try to return the created row
      const id = result && (result.insertId || (result[0] && result[0].insertId));
      if (!id) return cb(null, result);
      User.findById(id, cb);
    });
  },

  // Get user by email (case-insensitive) — includes password
  getByEmail(email, cb) {
    cb = safeCb(cb);
    query('SELECT * FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1', [String(email || '')], (err, rows) => {
      if (err) return cb(err);
      const row = Array.isArray(rows) ? (rows[0] || null) : rows || null;
      cb(null, row);
    });
  },

  // Update user fields by id (allows twoFactorSecret/twoFactorEnabled and password)
  updateById(id, data, cb) {
    cb = safeCb(cb);
    const row = normalizeInsert(data);
    // do not allow empty update
    if (!id) return cb(new Error('id is required'));
    if (Object.keys(row).length === 0) return cb(null, { affectedRows: 0 });

    const sets = Object.keys(row).map(k => `${k} = ?`).join(', ');
    const params = [...Object.keys(row).map(k => row[k]), Number(id)];
    const sql = `UPDATE users SET ${sets} WHERE id = ?`;
    query(sql, params, (err, result) => {
      if (err) return cb(err);
      cb(null, result);
    });
  },

  // Update only the password by id
  updatePasswordById(id, newHash, cb) {
    cb = safeCb(cb);
    if (!id) return cb(new Error('id is required'));
    query('UPDATE users SET password = ? WHERE id = ?', [String(newHash || ''), Number(id)], cb);
  },

  // Update password by email (case-insensitive)
  updatePasswordByEmail(email, newHash, cb) {
    cb = safeCb(cb);
    query('UPDATE users SET password = ? WHERE LOWER(email)=LOWER(?)', [String(newHash || ''), String(email || '')], cb);
  },

  // Delete user by id
  deleteById(id, cb) {
    cb = safeCb(cb);
    query('DELETE FROM users WHERE id = ?', [Number(id)], cb);
  },

  // Helper to set 2FA secret + enabled flag
  setTwoFactorById(id, base32Secret, enabled, cb) {
    cb = safeCb(cb);
    const payload = { twoFactorSecret: base32Secret || null, twoFactorEnabled: enabled ? 1 : 0 };
    this.updateById(id, payload, cb);
  }
};

// Backwards-compatible aliases used across controllers
User.getAll = User.findAll;
User.getUsers = User.findAll;
User.list = User.findAll;
User.all = User.findAll;

User.getById = User.findById;
User.getUserById = User.findById;
User.findOne = User.findById;

User.register = User.create;
User.add = User.create;
User.addUser = User.create;
User.insert = User.create;
User.createUser = User.create;

User.findByEmail = User.getByEmail;
User.findOneByEmail = User.getByEmail;
User.getUserByEmail = User.getByEmail;

User.update = User.updateById;
User.updateUser = User.updateById;
User.edit = User.updateById;
User.save = User.updateById;

User.changePassword = User.updatePasswordById;
User.setPassword = User.updatePasswordById;
User.resetPassword = User.updatePasswordById;

User.remove = User.deleteById;
User.delete = User.deleteById;
User.deleteUser = User.deleteById;
User.removeUser = User.deleteById;

// Export single object compatible with require('./models/User')
module.exports = User;