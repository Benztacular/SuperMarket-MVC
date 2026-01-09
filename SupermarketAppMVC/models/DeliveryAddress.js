const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }
function query(sql, params, cb) {
  cb = safeCb(cb);
  try {
    if (typeof db.query === 'function') return db.query(sql, params, cb);
    if (db && db.pool && typeof db.pool.query === 'function') return db.pool.query(sql, params, cb);
    throw new Error('DB client has no query method');
  } catch (err) {
    cb(err);
  }
}

function normalize(data = {}) {
  const out = {};
  const allow = ['user_id', 'recipient_name', 'contact_number', 'block_number', 'street_name', 'unit_number', 'postal_code', 'country', 'is_default'];
  for (const k of allow) {
    if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined && data[k] !== null) {
      out[k] = data[k];
    }
  }
  if (out.recipient_name) out.recipient_name = String(out.recipient_name).trim().slice(0, 100);
  if (out.contact_number) out.contact_number = String(out.contact_number).trim().slice(0, 20);
  if (out.block_number) out.block_number = String(out.block_number).trim().slice(0, 20);
  if (out.street_name) out.street_name = String(out.street_name).trim().slice(0, 255);
  if (out.unit_number) out.unit_number = String(out.unit_number).trim().slice(0, 20);
  if (out.postal_code) out.postal_code = String(out.postal_code).trim().slice(0, 20);
  if (out.country) out.country = String(out.country).trim().slice(0, 100);
  out.is_default = out.is_default ? 1 : 0;
  return out;
}

const DeliveryAddress = {
  findByUser(userId, cb) {
    cb = safeCb(cb);
    query(
      'SELECT * FROM delivery_addresses WHERE user_id = ? ORDER BY is_default DESC, updatedAt DESC, createdAt DESC',
      [Number(userId)],
      (err, rows) => cb(err, rows || [])
    );
  },

  findDefaultByUser(userId, cb) {
    cb = safeCb(cb);
    query(
      'SELECT * FROM delivery_addresses WHERE user_id = ? AND is_default = 1 ORDER BY updatedAt DESC, createdAt DESC LIMIT 1',
      [Number(userId)],
      (err, rows) => cb(err, rows && rows[0] ? rows[0] : null)
    );
  },

  createForUser(userId, data, cb) {
    cb = safeCb(cb);
    const row = normalize({ ...data, user_id: userId });
    if (!row.user_id) return cb(new Error('user_id is required'));
    if (!row.recipient_name || !row.block_number || !row.street_name || !row.postal_code || !row.unit_number) {
      return cb(new Error('recipient_name, block_number, street_name, unit_number, postal_code are required'));
    }

    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO delivery_addresses (${cols.join(', ')}) VALUES (${placeholders})`;
    query(sql, cols.map(k => row[k]), (err, result) => {
      if (err) return cb(err);
      const id = result && result.insertId;
      if (!id) return cb(null, result);
      // if this is the first address, set default
      DeliveryAddress.ensureOneDefault(userId, id, () => cb(null, { id, ...row }));
    });
  },

  setDefaultForUser(userId, addressId, cb) {
    cb = safeCb(cb);
    const uid = Number(userId);
    const aid = Number(addressId);
    if (!uid || !aid) return cb(new Error('userId and addressId are required'));
    query('UPDATE delivery_addresses SET is_default = 0 WHERE user_id = ?', [uid], (err) => {
      if (err) return cb(err);
      query('UPDATE delivery_addresses SET is_default = 1 WHERE user_id = ? AND id = ?', [uid, aid], cb);
    });
  },

  ensureOneDefault(userId, newId, cb) {
    cb = safeCb(cb);
    const uid = Number(userId);
    query('SELECT COUNT(*) AS cnt FROM delivery_addresses WHERE user_id = ?', [uid], (err, rows) => {
      if (err) return cb(err);
      const count = rows && rows[0] ? Number(rows[0].cnt || 0) : 0;
      if (count <= 1 && newId) {
        return DeliveryAddress.setDefaultForUser(uid, newId, cb);
      }
      return cb(null, { ensured: true });
    });
  }
};

// aliases
DeliveryAddress.listByUser = DeliveryAddress.findByUser;
DeliveryAddress.getDefault = DeliveryAddress.findDefaultByUser;
DeliveryAddress.create = DeliveryAddress.createForUser;
DeliveryAddress.setDefault = DeliveryAddress.setDefaultForUser;

module.exports = DeliveryAddress;
