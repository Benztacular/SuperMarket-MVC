const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }

function markStatus({ merchantRef, netsTxnId, status, paymentTime, amount, currency, rawResponse }, cb) {
  cb = safeCb(cb);

  // Accept rawResponse and try to extract identifiers if explicit ones missing
  let mr = merchantRef;
  let nx = netsTxnId;
  try {
    if (!mr && rawResponse) {
      mr = rawResponse.merchant_txn_ref || rawResponse.merchantTxnRef || rawResponse.merchant_ref || rawResponse.merchant || null;
    }
    if (!nx && rawResponse) {
      nx = rawResponse.txn_retrieval_ref || rawResponse.txnRetrievalRef || rawResponse.txn_retrieval || rawResponse.txn_id || rawResponse.rrn || rawResponse.stan || rawResponse.txn || null;
    }
  } catch (e) {
    // ignore
  }

  const sets = [];
  const params = [];
  if (status) { sets.push('payment_status = ?'); params.push(status); }
  if (paymentTime) { sets.push('payment_time = ?'); params.push(paymentTime); }
  if (nx) { sets.push('nets_txn_id = COALESCE(?, nets_txn_id)'); params.push(nx); }
  if (amount != null) { sets.push('amount = COALESCE(?, amount)'); params.push(Number(amount)); }
  if (currency) { sets.push('currency = COALESCE(?, currency)'); params.push(currency); }
  if (rawResponse) { sets.push('raw_response = ?'); params.push(JSON.stringify(rawResponse)); }
  sets.push('updated_at = CURRENT_TIMESTAMP');

  const where = [];
  if (mr) { where.push('merchant_txn_ref = ?'); params.push(mr); }
  if (nx) { where.push('nets_txn_id = ?'); params.push(nx); }

  // If we have at least one identifier, try update; otherwise we'll insert a row to persist the webhook
  if (where.length) {
    const sql = `UPDATE nets_transactions SET ${sets.join(', ')} WHERE ${where.join(' OR ')}`;
    try {
      return db.query(sql, params, (err, result) => {
        if (err) return cb(err);
        if (result && result.affectedRows === 0) {
          // no matching row, fallthrough to insert
        } else {
          return cb(null, result);
        }
        // proceed to insert below
        const insertSql = `INSERT INTO nets_transactions (
          user_id, order_id, merchant_txn_ref, nets_txn_id, amount, currency, payment_status, payment_time, raw_response, created_at
        ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NOW())`;
        const insertParams = [mr || null, nx || null, amount || 0, currency || 'SGD', status || 'PENDING', paymentTime || null, rawResponse ? JSON.stringify(rawResponse) : null];
        return db.query(insertSql, insertParams, cb);
      });
    } catch (err) {
      return cb(err);
    }
  }

  // No identifiers present: insert a minimal row so the webhook is recorded
  const insertSql = `INSERT INTO nets_transactions (
    user_id, order_id, merchant_txn_ref, nets_txn_id, amount, currency, payment_status, payment_time, raw_response, created_at
  ) VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NOW())`;
  const insertParams = [mr || null, nx || null, amount || 0, currency || 'SGD', status || 'PENDING', paymentTime || null, rawResponse ? JSON.stringify(rawResponse) : null];
  try {
    return db.query(insertSql, insertParams, cb);
  } catch (err) {
    return cb(err);
  }
}

function createPending({ userId, orderId, merchantRef, amount, currency, qrPayload, netsTxnId }, cb) {
  cb = safeCb(cb);
  if (!userId || !orderId || !merchantRef) return cb(new Error('Missing required fields'));
  const sql = `INSERT INTO nets_transactions (
    user_id, order_id, merchant_txn_ref, nets_txn_id, qr_payload, amount, currency, payment_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NOW())
  ON DUPLICATE KEY UPDATE
    nets_txn_id = VALUES(nets_txn_id),
    qr_payload = VALUES(qr_payload),
    amount = VALUES(amount),
    currency = VALUES(currency),
    payment_status = 'PENDING',
    updated_at = CURRENT_TIMESTAMP`;
  const params = [userId, orderId, merchantRef, netsTxnId || null, qrPayload || null, amount || 0, currency || 'SGD'];
  try {
    db.query(sql, params, cb);
  } catch (err) {
    cb(err);
  }
}

function findByMerchantRef(ref, cb) {
  cb = safeCb(cb);
  if (!ref) return cb(new Error('Missing merchant_ref'));
  db.query('SELECT * FROM nets_transactions WHERE merchant_txn_ref = ? LIMIT 1', [ref], cb);
}

module.exports = {
  markStatus,
  createPending,
  findByMerchantRef
};
