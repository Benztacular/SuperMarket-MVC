const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }
function unwrapRows(rows) { return rows; }

const TBL = 'cart_items';

// add({ userId, productId, quantity }, cb) OR add(userId, productId, quantity, cb)
function add(a, b, c, d) {
  let data, cb;
  if (typeof a === 'object' && a !== null) { data = a; cb = safeCb(b); }
  else { data = { user_id: a, product_id: b, quantity: c }; cb = safeCb(d); }

  const user_id = data.user_id || data.userId;
  const product_id = data.product_id || data.productId;
  const quantity = Math.max(1, Number(data.quantity || data.qty || 1));
  if (!user_id || !product_id) return cb(new Error('Missing user_id or product_id'));

  // upsert: try update, else insert
  db.query(
    `UPDATE ${TBL} SET quantity = quantity + ? WHERE user_id = ? AND product_id = ?`,
    [quantity, user_id, product_id],
    (err, r) => {
      if (err) return cb(err);
      if (r && r.affectedRows > 0) return cb(null, r);
      db.query(
        `INSERT INTO ${TBL} (user_id, product_id, quantity) VALUES (?, ?, ?)`,
        [user_id, product_id, quantity],
        cb
      );
    }
  );
}

function getByUser(userId, cb) {
  cb = safeCb(cb);
  const sql = `
    SELECT ci.id, ci.user_id, ci.product_id, ci.quantity,
           p.* 
    FROM ${TBL} ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
    ORDER BY ci.id DESC`;
  db.query(sql, [userId], cb);
}

function updateQuantity(id, quantity, cb) {
  cb = safeCb(cb);
  db.query(`UPDATE ${TBL} SET quantity = ? WHERE id = ?`, [quantity, id], cb);
}

function updateQuantityByUserProduct(user_id, product_id, quantity, cb) {
  cb = safeCb(cb);
  db.query(
    `UPDATE ${TBL} SET quantity = ? WHERE user_id = ? AND product_id = ?`,
    [quantity, user_id, product_id],
    cb
  );
}

function removeById(id, cb) {
  cb = safeCb(cb);
  db.query(`DELETE FROM ${TBL} WHERE id = ?`, [id], cb);
}

function removeByUserProduct(user_id, product_id, cb) {
  cb = safeCb(cb);
  db.query(
    `DELETE FROM ${TBL} WHERE user_id = ? AND product_id = ?`,
    [user_id, product_id],
    cb
  );
}

function clearByUser(user_id, cb) {
  cb = safeCb(cb);
  db.query(`DELETE FROM ${TBL} WHERE user_id = ?`, [user_id], cb);
}

// Optional: cart-only checkout (stock deduction + clear cart)
// Not used by OrderController, but kept for compatibility.
function checkout(user_id, cb) {
  cb = safeCb(cb);
  const getConn = (done) => {
    if (typeof db.getConnection === 'function') return db.getConnection(done);
    return done(null, db);
  };

  getConn((err, conn) => {
    if (err) return cb(err);
    const begin = (next) => (conn.beginTransaction ? conn.beginTransaction(next) : next());
    const commit = (next) => (conn.commit ? conn.commit(next) : next());
    const rollback = (next) => (conn.rollback ? conn.rollback(next) : next());

    begin((err) => {
      if (err) return cb(err);
      const selectSql = `
        SELECT ci.product_id, ci.quantity AS cartQty,
               p.productName, p.quantity AS stock, p.price
        FROM ${TBL} ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.user_id = ?
        FOR UPDATE`;
      conn.query(selectSql, [user_id], (err, rows) => {
        if (err) return rollback(() => cb(err));
        const items = rows || [];
        if (!items.length) return commit(() => cb(null, { count: 0, total: 0, items: [] }));

        const insufficient = items.filter(r => Number(r.stock) < Number(r.cartQty));
        if (insufficient.length) {
          return rollback(() => {
            const e = new Error('INSUFFICIENT_STOCK');
            e.code = 'INSUFFICIENT_STOCK';
            e.items = insufficient.map(r => ({
              product_id: r.product_id,
              name: r.productName,
              requested: Number(r.cartQty),
              available: Number(r.stock),
            }));
            cb(e);
          });
        }

        const updates = items.map(r => new Promise((resolve, reject) => {
          conn.query(
            'UPDATE products SET quantity = quantity - ? WHERE id = ?',
            [Number(r.cartQty), r.product_id],
            (e) => (e ? reject(e) : resolve())
          );
        }));

        Promise.all(updates).then(() => {
          conn.query(`DELETE FROM ${TBL} WHERE user_id = ?`, [user_id], (e) => {
            if (e) return rollback(() => cb(e));
            const total = items.reduce((s, r) => s + Number(r.price || 0) * Number(r.cartQty || 0), 0);
            commit((e2) => cb(e2, { count: items.length, total, items }));
          });
        }).catch((e) => rollback(() => cb(e)));
      });
    });
  });
}

module.exports = {
  getByUser,
  add,
  updateQuantity,
  updateQuantityByUserProduct,
  removeById,
  removeByUserProduct,
  checkout,
  clearByUser,

  // aliases
  findByUser: getByUser,
  getCart: getByUser,
  findCart: getByUser,
  insert: add,
  create: add,
  addToCart: add,
  update: updateQuantity, // controller also supports other signatures
  setQuantity: updateQuantity,
  changeQty: updateQuantity,
  deleteById: removeById,
  delete: removeById,
  remove: removeById,
  del: removeById,
  removeUserProduct: removeByUserProduct,
  deleteByUserProduct: removeByUserProduct,
  clearCartForUser: clearByUser,
  emptyCart: clearByUser,
  removeByUser: clearByUser
};