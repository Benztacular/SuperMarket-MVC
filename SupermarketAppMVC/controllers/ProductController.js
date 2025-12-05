const Product = require('../models/Product');
const db = require('../db'); // ensure db is required near top

// helper to resolve/insert category and return id
function ensureCategoryId(categoryName) {
  return new Promise((resolve, reject) => {
    if (!categoryName || !categoryName.trim()) return resolve(null);
    const name = categoryName.trim();
    db.query('SELECT id FROM categories WHERE categoryName = ?', [name], (err, rows) => {
      if (err) return reject(err);
      if (rows && rows.length) return resolve(rows[0].id);
      db.query('INSERT INTO categories (categoryName) VALUES (?)', [name], (err2, result) => {
        if (err2) return reject(err2);
        resolve(result.insertId);
      });
    });
  });
}

// helpers
function pick(obj, ...names) { for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj); return null; }
function unwrapRow(row) { if (!row) return null; if (Array.isArray(row)) return Array.isArray(row[0]) ? row[0][0] : row[0]; return row; }

// model bindings with fallback names
const productGetAll = pick(Product, 'getAll', 'findAll', 'list', 'all');
const productGetById = pick(Product, 'getById', 'findById', 'findOne', 'get');
const productCreate = pick(Product, 'create', 'add', 'insert');
const productUpdate = pick(Product, 'update', 'updateById', 'edit', 'save');
const productDelete = pick(Product, 'delete', 'deleteById', 'remove', 'destroy');

// Public pages
exports.list = (req, res) => {
  if (!productGetAll) return res.status(501).send('Product.getAll not implemented');
  productGetAll((err, products) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load products'); }
    res.render('shopping', { products: products || [] });
  });
};

exports.getById = (req, res) => {
  if (!productGetById) return res.status(501).send('Product.getById not implemented');
  productGetById(req.params.id, (err, product) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load product'); }
    const p = unwrapRow(product);
    if (!p) return res.status(404).send('Product not found');
    res.render('product', { product: p });
  });
};

// Server-side shopping landing (no client scripts) — renders views/shopping.ejs
exports.shopping = function (req, res, next) {
  const q = (req.query.q || '').trim();
  const sort = req.query.sort || '';
  const rawCats = req.query.category || [];
  const selectedCategories = Array.isArray(rawCats) ? rawCats : (rawCats ? [rawCats] : []);

  // build WHERE / params safely
  const where = [];
  const params = [];

  if (q) {
    where.push('(p.productName LIKE ?)');
    params.push(`%${q}%`);
  }

  if (selectedCategories.length) {
    // ensure numeric category IDs
    const catIds = selectedCategories.map(c => Number(c)).filter(Number.isFinite);
    if (catIds.length) {
      const placeholders = catIds.map(() => '?').join(',');
      where.push(`p.category_id IN (${placeholders})`);
      params.push(...catIds);
    }
  }

  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

  // choose ordering
  let orderSql = 'ORDER BY p.productName ASC';
  if (sort === 'name_desc') orderSql = 'ORDER BY p.productName DESC';
  if (sort === 'price_asc') orderSql = 'ORDER BY p.price ASC';
  if (sort === 'price_desc') orderSql = 'ORDER BY p.price DESC';

  // fetch products and categories (server-rendered filtering/sorting)
  const sqlProducts = `
    SELECT p.*, c.categoryName
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    ${whereSql}
    ${orderSql}
    LIMIT 200
  `;

  db.query(sqlProducts, params, (pErr, products) => {
    if (pErr) {
      console.error('shopping - products query error', pErr);
      return res.status(500).send('Failed to load products');
    }

    db.query('SELECT id, categoryName FROM categories ORDER BY categoryName', [], (cErr, categories) => {
      if (cErr) {
        console.error('shopping - categories query error', cErr);
        // still render products if categories fail
        return res.render('shopping', {
          list: products || [],
          categories: [],
          selectedCategories: selectedCategories.map(String),
          q,
          sort
        });
      }

      return res.render('shopping', {
        list: products || [],
        categories: categories || [],
        selectedCategories: selectedCategories.map(String),
        q,
        sort
      });
    });
  });
};

// Admin pages
exports.adminInventoryPage = (req, res) => {
  // load products with category name (left join)
  const sql = `SELECT p.id, p.productName, p.quantity, p.price, p.image, p.category_id,
                     c.categoryName AS category
               FROM products p
               LEFT JOIN categories c ON p.category_id = c.id
               ORDER BY p.id`;
  db.query(sql, (err, products) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load products'); }
    res.render('inventory', { products: products || [] });
  });
};

exports.adminCreate = async (req, res) => {
  try {
    const { productName, price, quantity } = req.body || {};
    const image = req.file ? req.file.filename : (req.body?.existingImage || '');
    const categoryName = req.body.category || '';

    let categoryId = null;
    try { categoryId = await ensureCategoryId(categoryName); } catch (e) { console.error('Category ensure failed', e); }

    const sql = 'INSERT INTO products (productName, quantity, price, image, category_id) VALUES (?, ?, ?, ?, ?)';
    const params = [productName, quantity || 0, price || 0, image || '', categoryId];
    db.query(sql, params, (err) => {
      if (err) {
        console.error('Create product error:', err);
        if (req.flash) req.flash('error', 'Failed to add product');
      } else {
        if (req.flash) req.flash('success', 'Product added');
      }
      res.redirect('/admin/inventory');
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin/inventory');
  }
};

exports.adminEditPage = (req, res) => {
  const id = req.params.id;
  const sql = `SELECT p.id, p.productName, p.quantity, p.price, p.image, p.category_id,
                     c.categoryName AS category
               FROM products p
               LEFT JOIN categories c ON p.category_id = c.id
               WHERE p.id = ? LIMIT 1`;
  db.query(sql, [id], (err, rows) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load product'); }
    if (!rows || rows.length === 0) return res.status(404).send('Product not found');
    const p = rows[0];
    res.render('editProduct', { product: p });
  });
};

exports.adminUpdate = async (req, res) => {
  try {
    const id = req.params.id;
    const productName = req.body.productName;
    const price = req.body.price;
    const quantity = req.body.quantity;
    // use uploaded file when present, otherwise preserve existingImage
    const image = (req.file && req.file.filename) ? req.file.filename : (req.body.existingImage || null);

    // resolve category name -> id (your form sends category name)
    const categoryName = req.body.category || '';
    let categoryId = null;
    try {
      categoryId = await ensureCategoryId(categoryName);
    } catch (catErr) {
      console.error('Category ensure failed', catErr);
      // continue with null categoryId (or handle differently)
    }

    const sql = 'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ?, category_id = ? WHERE id = ?';
    const params = [productName, quantity, price, image, categoryId, id];
    db.query(sql, params, (err) => {
      if (err) {
        console.error(err);
        req.flash('error', 'Failed to update product');
        return res.redirect('/admin/inventory');
      }
      req.flash('success', 'Product updated');
      res.redirect('/admin/inventory');
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin/inventory');
  }
};

exports.adminDelete = (req, res) => {
  if (!productDelete) return res.status(501).send('Product.delete not implemented');
  productDelete(req.params.id, (err) => {
    if (err) { console.error('Delete product error:', err); if (req.flash) req.flash('error', 'Failed to delete product'); }
    else { if (req.flash) req.flash('success', 'Product deleted'); }
    res.redirect('/admin/inventory');
  });
};

// show product detail by numeric id (fallback to productName if param isn't numeric)
exports.show = function (req, res, next) {
  try {
    const param = req.params.id;
    const id = Number(param);
    const sql = id
      ? 'SELECT id, productName, image, price, quantity FROM products WHERE id = ? LIMIT 1'
      : 'SELECT id, productName, image, price, quantity FROM products WHERE productName = ? LIMIT 1';
    const params = id ? [id] : [param];

    db.query(sql, params, (err, rows) => {
      if (err) return next(err);
      if (!rows || rows.length === 0) {
        return res.status(404).render('product', { product: null, error: ['Product not found'] });
      }
      return res.render('product', {
        product: rows[0],
        success: req.flash ? req.flash('success') : [],
        error: req.flash ? req.flash('error') : []
      });
    });
  } catch (err) { next(err); }
};

/**
 * Decrement stock for multiple items using the provided DB connection (transaction).
 * items = [{ productId, quantity }, ...]
 * cb(err) - err if any update failed (including insufficient stock)
 */
module.exports.decrementStockUsingConn = function (conn, items, cb) {
  console.log('decrementStockUsingConn called -> items=', JSON.stringify(items));
  cb = typeof cb === 'function' ? cb : () => {};
  if (!conn || typeof conn.query !== 'function') return cb(new Error('Connection required'));
  items = Array.isArray(items) ? items.filter(it => it && Number(it.quantity) > 0 && Number(it.productId)) : [];

  console.log('decrementStockUsingConn called. items:', items, 'conn?.query=', typeof conn.query === 'function');

  let i = 0;
  const next = () => {
    if (i >= items.length) {
      console.log('decrementStockUsingConn completed');
      return cb(null);
    }
    const it = items[i++];
    const pid = Number(it.productId || it.product_id || it.id || 0);
    const qty = Number(it.quantity || it.qty || 0);
    if (!pid || qty <= 0) return next();
    const sql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
    console.log('decrementStockUsingConn executing:', sql, [qty, pid, qty]);
    conn.query(sql, [qty, pid, qty], (err, res) => {
      if (err) return cb(err);
      console.log(`decrementStockUsingConn result for pid=${pid}: affectedRows=${res && res.affectedRows}`);
      const affected = (res && (res.affectedRows || 0)) || 0;
      if (!affected) return cb(new Error('Insufficient stock for product id ' + pid));
      return next();
    });
  };
  next();
};

/**
 * Alternative: decrement stock aggregated by reading order_items for orderId.
 * Useful if you want a single aggregated UPDATE (keeps your existing fallback approach).
 * cb(err)
 */
module.exports.decrementStockFromOrder = function (connOrDb, orderId, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  if (!orderId) return cb(new Error('orderId required'));
  // if connOrDb has .query assume it's a connection, otherwise use module db
  const exec = (sql, params, cbq) => {
    if (connOrDb && typeof connOrDb.query === 'function') return connOrDb.query(sql, params, cbq);
    return db.query(sql, params, cbq);
  };

  const sql = `
    UPDATE products p
    JOIN (
      SELECT product_id, SUM(quantity) AS qty
      FROM order_items
      WHERE order_id = ?
      GROUP BY product_id
    ) oi ON p.id = oi.product_id
    SET p.quantity = p.quantity - oi.qty
    WHERE p.quantity >= oi.qty
  `;
  exec(sql, [orderId], (err, res) => {
    if (err) return cb(err);
    const expected = 0; // caller can interpret affectedRows if needed
    return cb(null, res && res.affectedRows ? res.affectedRows : 0);
  });
};

/**
 * Run a query using provided connection (transaction connection) or fallback to global db.
 * conn should be the connection object returned by db.getConnection() (or the pool connection).
 */
function runQuery(conn, sql, params, cb) {
  if (!conn) return cb(new Error('No DB connection provided'));
  // connection objects from pool have a query method; the pool itself also has query
  conn.query(sql, params, cb);
}

/**
 * Decrement stock for a single product inside a transaction connection.
 * cb(err, result)
 */
exports.decrementStock = function (conn, productId, qty, cb) {
  if (!Number.isFinite(productId) || productId <= 0) return cb(new Error('Invalid productId'));
  qty = Number(qty) || 0;
  if (qty <= 0) return cb(null, { message: 'Nothing to decrement' });

  const sql = 'UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?';
  runQuery(conn, sql, [qty, productId, qty], (err, res) => {
    if (err) return cb(err);
    const affected = (res && (res.affectedRows || 0)) || 0;
    if (!affected) return cb(new Error('Insufficient stock for product id ' + productId));
    return cb(null, res);
  });
};

/**
 * Decrement stock for multiple items sequentially inside the same connection (transactional).
 * items: [{ id: <productId>, qty: <amount> }, ...]
 * cb(err, result)
 */
exports.decrementStockBatch = function (conn, items, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  if (!conn || typeof conn.query !== 'function') return cb(new Error('Missing DB connection'));

  const list = Array.isArray(items) ? items.map(it => ({
    id: Number(it.id || it.productId || it.product_id),
    qty: Math.max(0, Number(it.qty || it.quantity || 0))
  })).filter(it => Number.isFinite(it.id) && it.id > 0 && it.qty > 0) : [];

  if (list.length === 0) return cb(null, { updated: 0 });

  let idx = 0;
  let updatedCount = 0;

  const next = () => {
    if (idx >= list.length) return cb(null, { updated: updatedCount });
    const it = list[idx++];

    // Use GREATEST to avoid negative stock; perform update inside same transaction connection
    const sql = 'UPDATE products SET quantity = GREATEST(quantity - ?, 0) WHERE id = ?';
    conn.query(sql, [it.qty, it.id], (err, res) => {
      if (err) return cb(err);
      if (res && res.affectedRows) updatedCount += 1;
      // proceed to next item
      next();
    });
  };

  // start sequential updates
  next();
};

/**
 * Decrement product quantities for a given order using the provided DB connection.
 * This runs inside the caller's transaction/connection so it won't commit/rollback here.
 */
exports.decrementStockForOrder = function (conn, orderId, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  if (!conn || typeof conn.query !== 'function') return cb(new Error('Missing DB connection'));
  if (!orderId) return cb(new Error('Missing orderId'));

  const aggregateSql = `
    SELECT product_id, SUM(quantity) AS qty
    FROM order_items
    WHERE order_id = ?
    GROUP BY product_id
  `;

  conn.query(aggregateSql, [orderId], (err, rows) => {
    if (err) return cb(err);
    if (!rows || rows.length === 0) return cb(null, { updated: 0 });

    let pending = rows.length;
    let updatedCount = 0;
    let called = false;

    const finish = (e, result) => {
      if (called) return;
      called = true;
      return cb(e, result);
    };

    for (const r of rows) {
      const productId = Number(r.product_id);
      const qty = Number(r.qty || 0);
      if (!productId || qty <= 0) {
        pending -= 1;
        if (pending === 0) return finish(null, { updated: updatedCount, details: rows });
        continue;
      }

      // Decrement but don't allow negative stock (use GREATEST to floor at 0)
      const updateSql = 'UPDATE products SET quantity = GREATEST(quantity - ?, 0) WHERE id = ?';
      conn.query(updateSql, [qty, productId], (uErr, uRes) => {
        if (uErr) return finish(uErr);
        if (uRes && uRes.affectedRows) updatedCount += 1;
        pending -= 1;
        if (pending === 0) return finish(null, { updated: updatedCount, details: rows });
      });
    }
  });
};

// small convenience: get product row (transaction-safe)
exports.getById = function (conn, productId, cb) {
  runQuery(conn, 'SELECT * FROM products WHERE id = ? LIMIT 1', [productId], (err, rows) => {
    if (err) return cb(err);
    return cb(null, rows && rows[0] ? rows[0] : null);
  });
};

async function renderAddProductPage(req, res) {
  try {
    const [rows] = await db.query(
      "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY category"
    );
    const categories = rows.map((r) => r.category);
    res.render("addProduct", {
      categories,
      sessionUser: req.session.user || null,
    });
  } catch (err) {
    console.error("renderAddProductPage error:", err);
    res.status(500).send("Unable to open add product page");
  }
}

async function listCategories(req, res) {
  try {
    const [rows] = await db.query(
      "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY category"
    );
    res.json(rows.map((r) => r.category));
  } catch (err) {
    console.error("listCategories error:", err);
    res.status(500).json({ error: "Failed to load categories" });
  }
}

module.exports = {
  ...exports,
  renderAddProductPage,
  listCategories,
};