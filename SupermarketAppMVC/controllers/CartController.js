const Cart = require('../models/Cart');
const Product = require('../models/Product');
const db = require('../db'); // adjust path if different
const ProductController = require('./ProductController'); // add near top of file (with other requires)

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}
function pick(obj, ...names) { for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj); return null; }
const cartGetByUser = pick(Cart, 'getByUser', 'getCart', 'findByUser', 'listByUser');
const cartAdd       = pick(Cart, 'add', 'addItem', 'insert', 'upsert', 'create', 'addToCart');
const cartUpdate    = pick(Cart, 'update', 'updateItem', 'setQuantity', 'changeQty', 'updateQuantity', 'updateByUserProduct');
const cartRemove    = pick(Cart, 'remove', 'removeItem', 'delete', 'del', 'deleteById');

function normItems(rows) {
  const a = rows || [];
  return a.map(r => ({
    id: r.id || r.cartId,
    product_id: r.product_id || r.productId,
    productName: r.productName || r.name,
    price: Number(r.price || r.unitPrice || 0),
    quantity: Number(r.quantity || r.qty || 1),
    image: r.image || r.img || ''
  }));
}

// show cart page (load from DB cart_items)
exports.page = (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const sql = `
    SELECT ci.id AS cart_id, ci.quantity AS qty,
           p.*
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
  `;
  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error('Cart.page - db error', err);
      return res.status(500).send('Failed to load cart');
    }
    const items = (rows || []).map(r => {
      const resolvedName = r.productName || r.product_name || r.title || r.name || r.product || '';
      const price = Number(r.price || r.unitPrice || r.cost || 0);
      const quantity = Number(r.qty || r.quantity || 0);
      const productId = r.product_id || r.id;

      return {
        id: r.cart_id,
        product_id: productId,
        productName: resolvedName,
        price,
        quantity,
        image: r.image || r.img || ''
      };
    });
    const total = items.reduce((s, it) => s + it.price * it.quantity, 0);
    return res.render('cart', { items, cartItems: items, total });
  });
};

// add product to cart (SQL-backed)
exports.add = function (req, res, next) {
  console.log('CartController.add called', { body: req.body, headers: { referer: req.get('referer') } });

  const userId = uid(req);
  if (!userId) {
    const wantsJSON = req.xhr || (req.headers.accept||'').includes('application/json');
    if (wantsJSON) return res.status(401).json({ success:false, message:'Not authenticated' });
    return res.redirect('/login');
  }

  const productId = Number(req.body.productId || req.body.product_id || req.body.id || 0);
  let qty = parseInt(req.body.quantity || req.body.qty || '1', 10) || 1;
  if (qty < 1) qty = 1;

  const wantsJSON = req.xhr || (req.headers.accept||'').includes('application/json');
  const fallback = req.get('referer') || '/';

  if (!productId) {
    const msg = 'Invalid request: missing productId';
    if (wantsJSON) return res.status(400).json({ success:false, message: msg });
    if (req.flash) req.flash('error', msg);
    return res.redirect(fallback);
  }

  // load product row
  db.query('SELECT * FROM products WHERE id = ? LIMIT 1', [productId], (err, pRows) => {
    if (err) return next(err);
    const product = pRows && pRows[0];
    if (!product) {
      const msg = 'Product not found';
      if (wantsJSON) return res.status(404).json({ success:false, message: msg });
      if (req.flash) req.flash('error', msg);
      return res.redirect(fallback);
    }

    const available = Number(product.quantity || product.qty || product.stock || 0);
    const productLabel = product.name || product.productName || product.product_name || product.title || `#${product.id}`;
    console.log(`Adding ${qty} x ${productLabel} to cart`, { available, productId, userId });

    // check existing cart_items
    db.query('SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ? LIMIT 1', [userId, productId], (cErr, cRows) => {
      if (cErr) return next(cErr);
      const cartRow = cRows && cRows[0];
      const existingInCart = cartRow ? Number(cartRow.quantity || 0) : 0;

      const canAdd = Math.max(0, available - existingInCart);
      if (canAdd <= 0) {
        const msg = `Cannot add product. Only ${available} available and you already have ${existingInCart} in your cart.`;
        if (wantsJSON) return res.status(400).json({ success:false, message: msg, available, inCart: existingInCart });
        if (req.flash) req.flash('error', msg);
        return res.redirect(fallback);
      }

      const allowedToAdd = qty > canAdd ? canAdd : qty;

      if (cartRow) {
        const newQty = existingInCart + allowedToAdd;
        db.query('UPDATE cart_items SET quantity = ? WHERE id = ?', [newQty, cartRow.id], (uErr) => {
          if (uErr) return next(uErr);
          const msg = allowedToAdd < qty ? `Added ${allowedToAdd} (limited by stock)` : 'Added to cart';
          if (wantsJSON) return res.json({ success:true, message: msg, cartItem: { product_id: productId, quantity: newQty }, available, inCart: newQty });
          if (req.flash) req.flash('success', msg);
          return res.redirect(fallback);
        });
      } else {
        db.query('INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)', [userId, productId, allowedToAdd], (iErr, info) => {
          if (iErr) return next(iErr);
          const msg = allowedToAdd < qty ? `Added ${allowedToAdd} (limited by stock)` : 'Added to cart';
          if (wantsJSON) return res.json({ success:true, message: msg, cartItemId: info.insertId, cartItem: { product_id: productId, quantity: allowedToAdd }, available, inCart: allowedToAdd });
          if (req.flash) req.flash('success', msg);
          return res.redirect(fallback);
        });
      }
    });
  });
};

// update quantity
exports.update = (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const cartItemId = req.params.id ? Number(req.params.id) : Number(req.body.id || 0);
  const productIdFromBody = Number(req.body.productId || req.body.product_id || 0);
  let quantity = Number(req.body.quantity || req.body.qty || 0);

  const wantsJSON = req.xhr || (req.headers.accept || '').includes('application/json');
  const fallback = '/cart';

  function sendError(msg, status = 400) {
    if (wantsJSON) return res.status(status).json({ success: false, message: msg });
    if (req.flash) req.flash('error', msg);
    return res.redirect(fallback);
  }

  if (!cartItemId && !productIdFromBody) return res.redirect(fallback);
  if (!Number.isFinite(quantity) || quantity < 0) quantity = 0;

  function performUpdateFor(productId, cartRowId) {
    db.query('SELECT id, quantity FROM products WHERE id = ? LIMIT 1', [productId], (err, pRows) => {
      if (err) {
        console.error('Cart.update - product fetch error', err);
        return res.status(500).send('Failed to update cart');
      }
      const product = pRows && pRows[0];
      if (!product) return sendError('Product not found', 404);

      const available = Number(product.quantity || product.qty || product.stock || 0);

      if (quantity === 0) {
        if (cartRowId) {
          db.query('DELETE FROM cart_items WHERE id = ? AND user_id = ?', [cartRowId, userId], (dErr) => {
            if (dErr) { console.error('Cart.update - delete error', dErr); return res.status(500).send('Failed to update cart'); }
            if (wantsJSON) return res.json({ success: true, message: 'Item removed from cart' });
            if (req.flash) req.flash('success', 'Item removed from cart');
            return res.redirect('/cart');
          });
          return;
        } else {
          db.query('DELETE FROM cart_items WHERE user_id = ? AND product_id = ?', [userId, productId], (dErr) => {
            if (dErr) { console.error('Cart.update - delete error', dErr); return res.status(500).send('Failed to update cart'); }
            if (wantsJSON) return res.json({ success: true, message: 'Item removed from cart' });
            if (req.flash) req.flash('success', 'Item removed from cart');
            return res.redirect('/cart');
          });
          return;
        }
      }

      if (quantity > available) {
        return sendError(`Cannot set quantity to ${quantity}. Only ${available} available.`);
      }

      if (cartRowId) {
        db.query('UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?', [quantity, cartRowId, userId], (uErr) => {
          if (uErr) { console.error('Cart.update - update error', uErr); return res.status(500).send('Failed to update cart'); }
          if (wantsJSON) return res.json({ success: true, message: 'Cart updated', product_id: productId, quantity });
          if (req.flash) req.flash('success', 'Cart updated');
          return res.redirect('/cart');
        });
      } else {
        db.query('SELECT id FROM cart_items WHERE user_id = ? AND product_id = ? LIMIT 1', [userId, productId], (sErr, sRows) => {
          if (sErr) { console.error('Cart.update - select error', sErr); return res.status(500).send('Failed to update cart'); }
          if (sRows && sRows[0]) {
            db.query('UPDATE cart_items SET quantity = ? WHERE id = ?', [quantity, sRows[0].id], (uErr2) => {
              if (uErr2) { console.error('Cart.update - update error', uErr2); return res.status(500).send('Failed to update cart'); }
              if (wantsJSON) return res.json({ success: true, message: 'Cart updated', product_id: productId, quantity });
              if (req.flash) req.flash('success', 'Cart updated');
              return res.redirect('/cart');
            });
          } else {
            db.query('INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)', [userId, productId, quantity], (iErr) => {
              if (iErr) { console.error('Cart.update - insert error', iErr); return res.status(500).send('Failed to update cart'); }
              if (wantsJSON) return res.json({ success: true, message: 'Cart updated', product_id: productId, quantity });
              if (req.flash) req.flash('success', 'Cart updated');
              return res.redirect('/cart');
            });
          }
        });
      }
    });
  }

  if (cartItemId) {
    db.query('SELECT id, product_id, user_id FROM cart_items WHERE id = ? LIMIT 1', [cartItemId], (err, rows) => {
      if (err) { console.error('Cart.update - fetch cart item error', err); return res.status(500).send('Failed to update cart'); }
      const row = rows && rows[0];
      if (!row || Number(row.user_id) !== Number(userId)) return sendError('Cart item not found', 404);
      return performUpdateFor(Number(row.product_id), Number(row.id));
    });
  } else {
    const productId = productIdFromBody;
    return performUpdateFor(productId, null);
  }
};

// remove item
exports.remove = (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');
  if (!cartRemove) return res.status(501).send('Cart.remove not implemented');

  const cartItemId = req.params.id ? Number(req.params.id) : Number(req.body.id || 0);
  const productId = Number(req.body.productId || req.body.product_id || 0);
  const cb = (err) => {
    if (err) { console.error('Cart.remove error:', err); return res.status(500).send('Failed to remove item'); }
    return res.redirect('/cart');
  };

  if (cartItemId && Cart.removeById) Cart.removeById(cartItemId, cb);
  else if (productId && Cart.removeByUserProduct) Cart.removeByUserProduct(userId, productId, cb);
  else cartRemove({ id: cartItemId || undefined, userId, productId }, cb);
};

// clear cart
exports.clear = (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const wantsJSON = req.xhr || (req.headers.accept || '').includes('application/json');
  db.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (err, result) => {
    if (err) {
      console.error('Cart.clear - delete error', err);
      return wantsJSON
        ? res.status(500).json({ success: false, message: 'Failed to clear cart' })
        : res.status(500).render('cart', { items: [], cartItems: [], total: 0, error: 'Failed to clear cart' });
    }

    if (wantsJSON) return res.json({ success: true, removed: result?.affectedRows || 0 });
    if (req.flash) req.flash('success', 'Cart cleared');
    return res.redirect('/cart');
  });
};

// POST /cart/pay
exports.confirmPayment = function (req, res) {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  function aggregateByProduct(rows) {
    const map = {};
    (rows || []).forEach(r => {
      const id = Number(r.product_id);
      const q = Number(r.quantity || 0);
      if (!map[id]) map[id] = 0;
      map[id] += q;
    });
    return map;
  }

  const getConnection = (cb) => {
    if (typeof db.getConnection === 'function') {
      db.getConnection((err, conn) => cb(err, conn, true));
    } else {
      cb(null, db, false);
    }
  };

  getConnection((gErr, conn, pooled) => {
    if (gErr) {
      console.error('confirmPayment - getConnection error', gErr);
      return res.status(500).render('cart', { error: 'Failed to start DB transaction', items: [], cartItems: [], total: 0 });
    }

    const rollbackFail = (message, dbErr) => {
      try {
        conn.rollback(() => {
          if (pooled && typeof conn.release === 'function') conn.release();
          if (dbErr) console.error('confirmPayment dbErr:', dbErr);
          return res.status(400).render('cart', { error: message || 'Payment failed', items: [], cartItems: [], total: 0 });
        });
      } catch (e) {
        if (pooled && typeof conn.release === 'function') conn.release();
        console.error('confirmPayment rollback error', e);
        return res.status(500).render('cart', { error: 'Payment failed', items: [], cartItems: [], total: 0 });
      }
    };

    conn.beginTransaction((tErr) => {
      if (tErr) {
        if (pooled && typeof conn.release === 'function') conn.release();
        console.error('confirmPayment - beginTransaction error', tErr);
        return res.status(500).render('cart', { error: 'Transaction start failed', items: [], cartItems: [], total: 0 });
      }

      console.log('confirmPayment: reading cart for user', userId);
      const cartSql = `
        SELECT ci.id AS cart_id, ci.product_id, ci.quantity,
               p.price AS unit_price, p.productName AS product_name, p.quantity AS stock
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.user_id = ?
        FOR UPDATE
      `;
      conn.query(cartSql, [userId], (err, cartRows) => {
        if (err) return rollbackFail('Failed to read cart', err);
        console.log('confirmPayment: cartRows count =', (cartRows || []).length);
        if (!cartRows || cartRows.length === 0) {
          conn.rollback(() => { if (pooled && typeof conn.release === 'function') conn.release(); return res.redirect('/cart'); });
          return;
        }

        // availability check
        for (const r of cartRows) {
          const want = Number(r.quantity || 0);
          const avail = Number(r.stock || 0);
          if (want > avail) {
            return rollbackFail(`Cannot checkout. "${r.product_name}" only has ${avail} available.`);
          }
        }

        const total = cartRows.reduce((s, r) => s + Number(r.unit_price || 0) * Number(r.quantity || 0), 0);
        const agg = aggregateByProduct(cartRows);

        conn.query('INSERT INTO orders (user_id, totalAmount, status, createdAt) VALUES (?, ?, ?, NOW())', [userId, total, 'Pending'], (oErr, oRes) => {
          if (oErr) return rollbackFail('Failed to create order', oErr);
          const orderId = oRes.insertId;
          console.log('confirmPayment: created orderId =', orderId);

          // batch insert order_items
          const values = cartRows.map(r => [orderId, r.product_id, r.quantity, Number(r.unit_price || 0)]);
          const placeholders = values.map(() => '(?, ?, ?, ?)').join(', ');
          const flat = values.flat();

          conn.query(`INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES ${placeholders}`, flat, (oiErr, oiRes) => {
            if (oiErr) return rollbackFail('Failed to create order items', oiErr);
            console.log('confirmPayment: Inserted order_items for orderId=', orderId, 'rows=', (oiRes && oiRes.affectedRows) || 0);

            // --- START: decrement product stock for each ordered product (use cart_items.quantity) ---
            try {
              // build list from cartRows (cartRows came from SELECT cart_items JOIN products earlier)
              const itemsToDecrement = (cartRows || []).map(r => ({
                productId: Number(r.product_id || r.productId || r.id),
                quantity: Number(r.quantity || r.qty || 0)
              })).filter(it => Number.isFinite(it.productId) && it.productId > 0 && it.quantity > 0);

              // finalize: clear cart, commit transaction, release connection and redirect
              const finalize = () => {
                // after commit succeed, send the shopper to the canonical receipt route
                return res.redirect(`/orders/${orderId}/receipt`);
              };

              if (itemsToDecrement.length === 0) {
                console.log('confirmPayment: nothing to decrement for orderId=', orderId);
                return finalize();
              }

              // Use the correct ProductController function that expects { productId, quantity }
              ProductController.decrementStockUsingConn(conn, itemsToDecrement, (decErr) => {
                if (decErr) return rollbackFail('Failed to decrement product stock', decErr);
                console.log('confirmPayment: decremented stock for orderId=', orderId, 'items=', itemsToDecrement);
                // proceed to clear cart and commit only after successful decrement
                return finalize();
              });
            } catch (ex) {
              return rollbackFail('Stock decrement step failed', ex);
            }
            // --- END: decrement product stock ---
           });
        });
      });
    });
  });
};

// Render checkout page (GET /cart/pay) — use cart_items join so quantity comes from cart
exports.pay = function (req, res) {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const sql = `
    SELECT
      ci.id AS cart_id,
      ci.quantity AS quantity,
      p.id AS product_id,
      p.productName,
      p.price,
      p.image,
      p.quantity AS stock
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error('Cart.pay - db error', err);
      return res.status(500).render('pay', { items: [], cartItems: [], total: 0, error: 'Failed to load checkout' });
    }

    const items = (rows || []).map(r => ({
      id: r.product_id,
      cartId: r.cart_id,
      productName: r.productName || '',
      price: Number(r.price || 0),
      quantity: Number(r.quantity || 0), // cart quantity preserved here
      image: r.image || '',
      stock: Number(r.stock || 0) // product stock aliased separately
    }));

    const total = items.reduce((sum, it) => sum + (it.price * it.quantity), 0);

    return res.render('pay', { items, cartItems: items, total });
  });
};