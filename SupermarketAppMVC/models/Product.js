const db = require('../db');

function normalize(data = {}) {
  const productName = String((data.productName ?? data.name ?? '')).trim();
  const price = parseFloat(data.price);
  const quantity = Number.isFinite(parseInt(data.quantity, 10)) ? parseInt(data.quantity, 10) : 0;
  const image = String((data.image ?? '')).trim();
  return { productName, price, quantity, image };
}

function getAll(cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  db.query('SELECT * FROM products ORDER BY id DESC', [], (err, rows) => cb(err, rows || []));
}

function getById(id, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  db.query('SELECT * FROM products WHERE id = ? LIMIT 1', [id], (err, rows) => {
    if (err) return cb(err);
    cb(null, rows && rows[0] ? rows[0] : null);
  });
}

function create(data, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  const { productName, price, quantity, image } = normalize(data);
  if (!productName || !Number.isFinite(price)) {
    return cb(new Error('productName and price are required'));
  }
  db.query(
    'INSERT INTO products (productName, quantity, price, image) VALUES (?, ?, ?, ?)',
    [productName, quantity, price, image],
    cb
  );
}

function update(id, data, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  const { productName, price, quantity, image } = normalize(data);
  if (!productName || !Number.isFinite(price)) {
    return cb(new Error('productName and price are required'));
  }
  db.query(
    'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ? WHERE id = ?',
    [productName, quantity, price, image, id],
    cb
  );
}

function remove(id, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  db.query('DELETE FROM products WHERE id = ?', [id], cb);
}

/**
 * Reduce stock for a single product.
 * - If `conn` is a DB connection (pool connection / transaction) it will be used.
 * - Signature flexible: reduceStock(conn, productId, qty, cb) OR reduceStock(productId, qty, cb)
 * cb(err, affectedRows)
 */
function reduceStock(conn, productId, qty, cb) {
  // normalize arguments (allow calls reduceStock(productId, qty, cb) )
  if (typeof conn === 'number' || typeof conn === 'string') {
    cb = qty;
    qty = productId;
    productId = conn;
    conn = null;
  } else if (typeof conn === 'function') {
    cb = conn;
    conn = null;
  }

  cb = typeof cb === 'function' ? cb : () => {};

  const sql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
  const params = [Number(qty || 0), Number(productId || 0), Number(qty || 0)];

  // debug log
  // console.log('reduceStock SQL:', sql, params);

  // use provided connection if available (transaction-safe)
  if (conn && typeof conn.query === 'function') {
    return conn.query(sql, params, (err, res) => {
      if (err) return cb(err);
      // res.affectedRows indicates if the update occurred
      // console.log('reduceStock (txn) affectedRows=', res && res.affectedRows);
      return cb(null, (res && (res.affectedRows || 0)) || 0);
    });
  }

  // fallback to module-level db
  try {
    const dbFallback = require('../db');
    return dbFallback.query(sql, params, (err, res) => {
      if (err) return cb(err);
      // console.log('reduceStock affectedRows=', res && res.affectedRows);
      return cb(null, (res && (res.affectedRows || 0)) || 0);
    });
  } catch (e) {
    return cb(e);
  }
}

/**
 * Reduce stock for multiple items sequentially inside given connection (if provided).
 * Accepts either:
 *   reduceStockBulk(conn, items, cb)
 *   reduceStockBulk(items, cb)
 */
function reduceStockBulk(connOrItems, maybeItems, maybeCb) {
  let conn = null;
  let items = [];
  let cb = typeof maybeCb === 'function' ? maybeCb : (typeof maybeItems === 'function' ? maybeItems : null);

  // Determine form of arguments
  if (typeof maybeItems === 'function' && Array.isArray(connOrItems)) {
    // called as (items, cb)
    items = connOrItems.slice();
    conn = null;
  } else {
    // called as (conn, items, cb)
    conn = (connOrItems && typeof connOrItems.query === 'function') ? connOrItems : null;
    items = Array.isArray(maybeItems) ? maybeItems.slice() : Array.isArray(connOrItems) ? connOrItems.slice() : [];
  }

  cb = typeof cb === 'function' ? cb : () => {};
  items = items || [];

  // diagnostic log (uncomment if needed)
  // console.log('reduceStockBulk called, conn?', !!conn, 'items:', items);

  let i = 0;
  const next = () => {
    if (i >= items.length) return cb(null);
    const it = items[i++];
    const pid = Number(it.productId || it.product_id || it.id || 0);
    const qty = Number(it.quantity || it.qty || 0);
    if (!pid || qty <= 0) return next();

    // call reduceStock with the same conn when available
    try {
      reduceStock(conn || null, pid, qty, (err, affected) => {
        if (err) return cb(err);
        if (!affected || affected === 0) return cb(new Error('Insufficient stock for product id ' + pid));
        return next();
      });
    } catch (e) {
      return cb(e);
    }
  };

  next();
}

/**
 * Reduce stock for an entire order using order_items aggregation.
 * Signatures supported:
 *  - reduceStockForOrder(orderId, cb)
 *  - reduceStockForOrder(conn, orderId, cb)
 *
 * Runs on provided connection if one is passed (transaction-safe).
 * cb(err, { affectedRows, expected })
 */
function reduceStockForOrder(connOrOrderId, maybeOrderId, maybeCb) {
  let conn = null;
  let orderId;
  let cb;

  if (connOrOrderId && typeof connOrOrderId.query === 'function') {
    conn = connOrOrderId;
    orderId = maybeOrderId;
    cb = typeof maybeCb === 'function' ? maybeCb : () => {};
  } else {
    conn = null;
    orderId = connOrOrderId;
    cb = typeof maybeOrderId === 'function' ? maybeOrderId : (typeof maybeCb === 'function' ? maybeCb : () => {});
  }

  if (!orderId) return cb(new Error('Missing orderId'));

  const run = (c, sql, params, done) => {
    if (c && typeof c.query === 'function') return c.query(sql, params, done);
    return db.query(sql, params, done);
  };

  const updateSql = `
    UPDATE products p
    JOIN (
      SELECT product_id, SUM(quantity) AS qty
      FROM order_items
      WHERE order_id = ?
      GROUP BY product_id
    ) oi ON oi.product_id = p.id
    SET p.quantity = p.quantity - oi.qty
    WHERE p.quantity >= oi.qty
  `;

  run(conn, updateSql, [orderId], (uErr, uRes) => {
    if (uErr) return cb(uErr);
    const affected = (uRes && (uRes.affectedRows || 0)) || 0;

    // count expected distinct products for this order
    run(conn, 'SELECT COUNT(DISTINCT product_id) AS c FROM order_items WHERE order_id = ?', [orderId], (cErr, cRes) => {
      if (cErr) return cb(cErr);
      const expected = (cRes && cRes[0] && Number(cRes[0].c)) || 0;
      if (affected < expected) return cb(new Error('Insufficient stock for one or more items'));
      return cb(null, { affectedRows: affected, expected });
    });
  });
}

// Export all functions (include the new helpers directly)
module.exports = {
  getAll,
  getById,
  create,
  update,
  delete: remove,
  // Backwards-compatible aliases used by controllers
  findAll: getAll,
  list: getAll,
  all: getAll,
  findById: getById,
  findOne: getById,
  get: getById,
  add: create,
  insert: create,
  updateById: update,
  edit: update,
  save: update,
  deleteById: remove,
  remove,
  destroy: remove,
  // export helpers directly
  reduceStock,
  reduceStockBulk,
  reduceStockForOrder
};