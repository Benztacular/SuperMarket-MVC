const Order = require('../models/Order');
const OrderItem = require('../models/Order_Item');
const Cart = require('../models/Cart');
const db = require('../db');

// helpers
function unwrap(row) { if (!row) return null; if (Array.isArray(row)) return Array.isArray(row[0]) ? row[0][0] : row[0]; return row; }
function pick(obj, ...names) { for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj); return null; }

// model function bindings (support multiple possible names)
const orderCreate = pick(Order, 'create', 'add', 'insert', 'placeOrder');
const orderGetById = pick(Order, 'getById', 'findById', 'findOne', 'getOne');
const orderListByUser = pick(Order, 'getByUser', 'findByUser', 'listByUser', 'findAllByUser');
const orderListAll = pick(Order, 'getAll', 'findAll', 'list', 'all');
const orderUpdateById = pick(Order, 'updateById', 'updateOrder', 'update');

const cartGetByUser = pick(Cart, 'getByUser', 'findByUser', 'getCart', 'findCart');
const cartClearByUser = pick(Cart, 'clearByUser', 'emptyCart', 'removeByUser');

const orderItemCreate = pick(OrderItem, 'create', 'add', 'insert');

// Create/place an order from the current user's cart
async function placeOrder(req, res) {
  try {
    console.log('Reached placeOrder');

    // resolve user id from session
    const sessionUser = req.session && (req.session.user || null);
    const userId = (req.session && req.session.userId) || (sessionUser && sessionUser.id) || null;
    if (!userId) return res.redirect('/login');

    // load cart items via Cart model if available, otherwise direct DB query
    const handleCartRows = (err, cartRows) => {
      if (err) { console.error(err); return res.status(500).send('Failed to load cart'); }
      const items = cartRows || [];
      if (!items.length) {
        if (req.flash) req.flash('error', 'Your cart is empty');
        return res.redirect('/cart');
      }

      const total = items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.quantity || it.qty || 0)), 0);
      const createdAt = new Date();

      // create order
      if (!Order.create) {
        // fallback if model binding not present
        const insertOrderSql = 'INSERT INTO orders (user_id, totalAmount, createdAt) VALUES (?, ?, ?)';
        db.query(insertOrderSql, [userId, total, createdAt], (oErr, oRes) => {
          if (oErr) { console.error(oErr); return res.status(500).send('Failed to create order'); }
          const orderId = oRes && (oRes.insertId || (Array.isArray(oRes) && oRes[0] && oRes[0].insertId));
          proceedInsertItems(orderId, items, createdAt);
        });
        return;
      }

      Order.create({ userId, totalAmount: total, createdAt }, (oErr, oRes) => {
        if (oErr) { console.error(oErr); return res.status(500).send('Failed to create order'); }
        const orderId = (oRes && (oRes.insertId || oRes.id)) || (Array.isArray(oRes) && oRes[0] && oRes[0].insertId);
        console.log('orderId =', orderId);
        if (!orderId) { console.error('No order id returned'); return res.status(500).send('Failed to create order'); }
        proceedInsertItems(orderId, items, createdAt);
      });
    };

    // insert order_items then clear cart and redirect
    function proceedInsertItems(orderId, items, createdAt) {
      if (!items.length) {
        // nothing to insert
        if (req.session) req.session.cart = null;
        if (Cart.clearByUser) Cart.clearByUser(userId, () => {});
        return res.redirect('/orders/receipt/' + orderId);
      }

      let pending = items.length;
      items.forEach((it) => {
        const payload = {
          orderId,
          productId: it.product_id || it.productId || it.id,
          quantity: it.quantity || it.qty || 1,
          price: it.price || it.unitPrice || 0,
          createdAt
        };

        if (typeof OrderItem.create === 'function') {
          OrderItem.create(payload, (iErr) => {
            if (iErr) console.error('OrderItem.create error', iErr);
            if (--pending === 0) finish();
          });
        } else {
          // fallback to direct insert
          const insertSql = 'INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES (?, ?, ?, ?, ?)';
          db.query(insertSql, [payload.orderId, payload.productId, payload.quantity, payload.price, payload.createdAt], (iErr) => {
            if (iErr) console.error('order_items insert error', iErr);
            if (--pending === 0) finish();
          });
        }
      });

      function finish() {
        // clear cart_items (model or direct)
        if (req.session) req.session.cart = null;
        if (typeof Cart.clearByUser === 'function') {
          Cart.clearByUser(userId, (cErr) => {
            if (cErr) console.error('Cart.clearByUser error', cErr);
            return res.redirect('/orders/receipt/' + orderId);
          });
        } else {
          db.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (dErr) => {
            if (dErr) console.error('Failed to clear cart', dErr);
            return res.redirect(`/orders/${orderId}/receipt`);
          });
        }
      }
    }

    // use Cart.getByUser if available
    if (typeof Cart.getByUser === 'function') {
      Cart.getByUser(userId, handleCartRows);
    } else {
      const sqlCart = `
        SELECT ci.id, ci.user_id, ci.product_id, ci.quantity, p.price, p.productName
        FROM cart_items ci
        LEFT JOIN products p ON p.id = ci.product_id
        WHERE ci.user_id = ?`;
      db.query(sqlCart, [userId], handleCartRows);
    }
  } catch (ex) {
    console.error(ex);
    res.status(500).send('Server error');
  }
}

// List orders for current user
function orderHistory(req, res) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (!orderListByUser) return res.status(501).json({ error: 'Order.getByUser not implemented' });
  orderListByUser(user.id, (err, rows) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Failed to load orders' }); }
    const orders = rows || [];
    return res.json({ orders });
  });
}

// View a single order (with items if model supports)
function viewOrder(req, res) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (!orderGetById) return res.status(501).json({ error: 'Order.getById not implemented' });
  orderGetById(req.params.id, (err, row) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'Failed to load order' }); }
    const order = unwrap(row);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // don't expose other users' orders unless admin
    if (order.userId && Number(order.userId) !== Number(user.id) && user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.json({ order });
  });
}

// ADMIN: list all orders (renders adminOrders.ejs)
function adminOrdersPage(req, res) {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }

  // use model function if available
  if (typeof Order.getAll === 'function') {
    Order.getAll((err, rows) => {
      if (err) { console.error(err); return res.status(500).send('Failed to load orders'); }
      const orders = rows || [];
      return res.render('adminOrders', { orders });
    });
    return;
  }

  // fallback direct query
  db.query('SELECT id AS orderId, user_id AS userId, totalAmount, status, createdAt FROM orders ORDER BY id DESC', [], (err, rows) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load orders'); }
    return res.render('adminOrders', { orders: rows || [] });
  });
}

// ADMIN: update status
function adminUpdateOrderStatus(req, res) {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }
  const orderId = req.params.id;
  const status = (req.body && req.body.status) ? String(req.body.status).trim() : null;
  if (!status) return res.redirect('/admin/orders');

  if (typeof Order.updateStatus === 'function') {
    Order.updateStatus(orderId, status, (err) => {
      if (err) { console.error(err); return res.status(500).send('Failed to update order'); }
      return res.redirect('/admin/orders');
    });
    return;
  }

  db.query('UPDATE orders SET status = ? WHERE id = ?', [status, orderId], (err) => {
    if (err) { console.error(err); return res.status(500).send('Failed to update order'); }
    return res.redirect('/admin/orders');
  });
}

// New / updated functions using db.query() as requested

// Checkout: create order from cart_items, insert order_items, clear cart_items, redirect to receipt
const checkout = function (req, res, next) {
  const userId = req.session?.user?.id || req.session?.userId;
  if (!userId) return res.redirect('/login');

  const conn = db; // single shared connection
  const release = () => {
    if (typeof conn.release === 'function') conn.release();
  };
  const rollback = (code, err) => {
    console.error('checkout:', code, err || '');
    conn.rollback(() => {
      release();
      if (code === 'EMPTY_CART') {
        req.flash?.('error', 'Your cart is empty.');
        return res.redirect('/cart');
      }
      if (code === 'OUT_OF_STOCK') {
        req.flash?.('error', 'Not enough stock for one or more items.');
        return res.redirect('/cart');
      }
      return next(err || new Error(code));
    });
  };

  conn.beginTransaction((txErr) => {
    if (txErr) return rollback('BEGIN_FAIL', txErr);

    const cartSql = `
      SELECT
        ci.id         AS cart_id,
        ci.product_id AS product_id,
        ci.quantity   AS cart_qty,
        p.quantity    AS stock_qty,
        p.price       AS price
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ?
      FOR UPDATE
    `;

    conn.query(cartSql, [userId], (cartErr, cartRows = []) => {
      if (cartErr) return rollback('LOAD_CART_FAIL', cartErr);
      if (!cartRows.length) return rollback('EMPTY_CART');

      const insufficient = cartRows.find(row => Number(row.cart_qty) > Number(row.stock_qty));
      if (insufficient) return rollback('OUT_OF_STOCK');

      const totalAmount = cartRows.reduce(
        (sum, row) => sum + Number(row.price || 0) * Number(row.cart_qty || 0),
        0
      );

      conn.query(
        'INSERT INTO orders (user_id, orderDate, totalAmount, status, createdAt) VALUES (?, NOW(), ?, "Pending", NOW())',
        [userId, totalAmount],
        (orderErr, orderRes) => {
          if (orderErr) return rollback('INSERT_ORDER_FAIL', orderErr);

          const orderId = orderRes.insertId;
          const valuesSql = cartRows.map(() => '(?, ?, ?, ?, NOW())').join(',');
          const valuesParams = cartRows.flatMap(row => [
            orderId,
            row.product_id,
            Number(row.cart_qty),
            Number(row.price || 0)
          ]);

          conn.query(
            `INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES ${valuesSql}`,
            valuesParams,
            (itemsErr) => {
              if (itemsErr) return rollback('INSERT_ITEMS_FAIL', itemsErr);

              const stockUpdates = cartRows.map(row => new Promise((resolve, reject) => {
                conn.query(
                  'UPDATE products SET quantity = quantity - ? WHERE id = ?',
                  [Number(row.cart_qty), row.product_id],
                  (updErr, updRes) => (updErr ? reject(updErr) : resolve(updRes))
                );
              }));

              Promise.all(stockUpdates)
                .then(() => {
                  conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (clearErr) => {
                    if (clearErr) return rollback('CLEAR_CART_FAIL', clearErr);

                    conn.commit((commitErr) => {
                      if (commitErr) return rollback('COMMIT_FAIL', commitErr);
                      release();
                      return res.redirect(`/orders/${orderId}/receipt`);
                    });
                  });
                })
                .catch((decErr) => rollback('DECREMENT_FAIL', decErr));
            }
          );
        }
      );
    });
  });
};

exports.checkout = checkout;

// showReceipt: load order and its items (joined to products) and render receipt.ejs
function showReceipt(req, res) {
  const sessionUser = req.session && (req.session.user || null);
  const userId = (req.session && req.session.userId) || (sessionUser && sessionUser.id) || null;
  if (!userId) return res.redirect('/login');

  const orderId = req.params.id;
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId], (err, rows) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load order'); }
    const order = Array.isArray(rows) ? rows[0] : rows;
    if (!order) return res.status(404).send('Order not found');

    // ensure ownership
    if (Number(order.user_id) !== Number(userId) && !(req.session.user && req.session.user.role === 'admin')) {
      return res.status(403).send('Forbidden');
    }

    const itemsSql = `
      SELECT oi.id, oi.product_id, oi.quantity, oi.price, p.productName
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?`;
    db.query(itemsSql, [orderId], (iErr, itemRows) => {
      if (iErr) { console.error(iErr); return res.status(500).send('Failed to load order items'); }
      const items = itemRows || [];
      return res.render('receipt', {
        orderId: order.id,
        createdAt: order.createdAt,
        items,
        totalAmount: order.totalAmount
      });
    });
  });
}

// history: list all orders for current user and render orderHistory.ejs
function history(req, res) {
  const sessionUser = req.session?.user;
  const userId = sessionUser?.id || req.session?.userId;
  if (!userId) return res.redirect('/login');

  db.query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [userId], (err, rows = []) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load orders'); }

    res.render('orderHistory', {
      orders: rows,
      pageTitle: 'Current Orders',
      showDelivered: false,
      user: sessionUser,
      isAdmin: sessionUser?.role === 'admin'
    });
  });
}

function orderHistoryPage(req, res) {
  const sessionUser = req.session?.user;
  const userId = sessionUser?.id || req.session?.userId;
  if (!userId) return res.redirect('/login');

  db.query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [userId], (err, rows = []) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load orders'); }

    res.render('orderHistory', {
      orders: rows,
      pageTitle: 'Order History',
      showDelivered: true,
      user: sessionUser,
      isAdmin: sessionUser?.role === 'admin'
    });
  });
}

// details: load a single order + its items (joined) and render orderDetails.ejs
function details(req, res) {
  const sessionUser = req.session && (req.session.user || null);
  const userId = (req.session && req.session.userId) || (sessionUser && sessionUser.id) || null;
  if (!userId) return res.redirect('/login');

  const orderId = req.params.id;
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId], (err, rows) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load order'); }
    const order = Array.isArray(rows) ? rows[0] : rows;
    if (!order) return res.status(404).send('Order not found');
    if (Number(order.user_id) !== Number(userId) && !(req.session.user && req.session.user.role === 'admin')) return res.status(403).send('Forbidden');

    const itemsSql = `
      SELECT oi.id, oi.product_id, oi.quantity, oi.price, p.productName
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?`;
    db.query(itemsSql, [orderId], (iErr, itemRows) => {
      if (iErr) { console.error(iErr); return res.status(500).send('Failed to load order items'); }
      const items = itemRows || [];
      // render existing receipt view instead of missing "orderDetails"
      return res.render('receipt', {
        order: orderRow,
        items: orderItems,
        total: totalAmount,
        user: req.session.user
      });
    });
  });
}

// ADMIN: list all orders (renders adminOrders.ejs)
exports.adminList = (req, res, next) => {
  const sql = `
    SELECT  o.id AS orderId,
            o.user_id,
            o.orderDate,
            o.totalAmount,
            o.createdAt,
            o.status,
            u.username,
            u.email,
            u.contact,
            u.address
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ORDER BY o.createdAt DESC
  `;
  db.query(sql, (err, rows) => {
    if (err) return next(err);
    res.render('adminOrders', { orders: rows || [] });
  });
};

exports.adminDetails = (req, res, next) => {
  const orderSql = `
    SELECT  o.*,
            u.username,
            u.email,
            u.contact,
            u.address
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ?
  `;
  const itemsSql = `
    SELECT  oi.*,
            p.productName,
            p.image
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `;
  db.query(orderSql, [req.params.id], (err, orderRows) => {
    if (err) return next(err);
    if (!orderRows?.length) return res.status(404).render('adminOrderDetails', { order: null, items: [] });
    db.query(itemsSql, [req.params.id], (itemErr, itemRows) => {
      if (itemErr) return next(itemErr);
      res.render('adminOrderDetails', { order: orderRows[0], items: itemRows || [] });
    });
  });
};

module.exports = {
  placeOrder,
  orderHistory,
  viewOrder,
  adminOrdersPage,
  adminUpdateOrderStatus,
  checkout,
  showReceipt,
  history,
  details,
  adminList: exports.adminList,
  adminDetails: exports.adminDetails
};