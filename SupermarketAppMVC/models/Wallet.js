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

const Wallet = {
  findByUserId(userId, cb) {
    cb = safeCb(cb);
    query('SELECT * FROM user_wallets WHERE user_id = ? LIMIT 1', [Number(userId)], (err, rows) => {
      if (err) return cb(err);
      const row = Array.isArray(rows) ? (rows[0] || null) : rows || null;
      cb(null, row);
    });
  },

  createForUser(userId, cb) {
    cb = safeCb(cb);
    query('INSERT INTO user_wallets (user_id, balance, createdAt) VALUES (?, 0.00, NOW())', [Number(userId)], (err, result) => {
      if (err) return cb(err);
      Wallet.findByUserId(userId, cb);
    });
  },

  // increment (or decrement) wallet balance by amount
  updateBalanceByUserId(userId, amount, cb) {
    cb = safeCb(cb);
    query('UPDATE user_wallets SET balance = COALESCE(balance,0) + ?, updatedAt = NOW() WHERE user_id = ?', [Number(amount), Number(userId)], (err, result) => {
      if (err) return cb(err);
      Wallet.findByUserId(userId, cb);
    });
  },

  addTransaction(payload, cb) {
    cb = safeCb(cb);
    const cols = ['wallet_id','user_id','type','amount','reference_type','reference_id','description','createdAt'];
    const vals = [payload.wallet_id, payload.user_id, payload.type, payload.amount, payload.reference_type || null, payload.reference_id || null, payload.description || null, new Date()];

    const doInsert = (done) => {
      query(`INSERT INTO wallet_transactions (${cols.join(',')}) VALUES (?,?,?,?,?,?,?,?)`, vals, (err, result) => {
        if (err) return done(err);
        return done(null, result);
      });
    };

    // Attempt insert; if we receive a data-truncation warning for reference_id, try to alter column and retry once
    doInsert((err, res) => {
      if (!err) return cb(null, res);
      const isTruncation = err && (err.code === 'WARN_DATA_TRUNCATED' || err.errno === 1265 || (err.sqlMessage && err.sqlMessage.includes('Data truncated')));
      if (!isTruncation) return cb(err);

      // Attempt to alter column to accommodate longer reference ids
      query("ALTER TABLE wallet_transactions MODIFY reference_id VARCHAR(255) NULL", [], (alterErr) => {
        if (alterErr) {
          return cb(alterErr);
        }
        // retry insert once
        doInsert((rErr, rRes) => {
          if (rErr) return cb(rErr);
          return cb(null, rRes);
        });
      });
    });
  },

  getTransactionsByUserId(userId, cb) {
    cb = safeCb(cb);
    const sql = `SELECT wt.* FROM wallet_transactions wt WHERE wt.user_id = ? ORDER BY wt.createdAt DESC`;
    query(sql, [Number(userId)], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows || []);
    });
  }
};

module.exports = Wallet;
