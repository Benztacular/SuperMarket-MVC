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
        if (req.session) req.session.cart = null;
        if (Cart.clearByUser) return Cart.clearByUser(userId, () => res.redirect(`/orders/${orderId}/receipt`));
        return db.query('DELETE FROM cart_items WHERE user_id = ?', [userId], () => res.redirect(`/orders/${orderId}/receipt`));
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
          const insertSql = 'INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES (?, ?, ?, ?, ?)';
          db.query(insertSql, [payload.orderId, payload.productId, payload.quantity, payload.price, payload.createdAt], (iErr) => {
            if (iErr) console.error('order_items insert error', iErr);
            if (--pending === 0) finish();
          });
        }
      });

      function finish() {
        if (req.session) req.session.cart = null;
        if (typeof Cart.clearByUser === 'function') {
          return Cart.clearByUser(userId, (cErr) => {
            if (cErr) console.error('Cart.clearByUser error', cErr);
            return res.redirect(`/orders/${orderId}/receipt`);
          });
        }

        db.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (dErr) => {
          if (dErr) console.error('Failed to clear cart', dErr);
          return res.redirect(`/orders/${orderId}/receipt`);
        });
      }
    }
  } catch (err) {
    console.error('placeOrder error', err);
    return res.status(500).send('Failed to place order');
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
      if (code === 'NO_ADDRESS') {
        req.flash?.('error', 'Please add a delivery address.');
        return res.redirect('/cart/checkout');
      }
      if (code === 'NO_SHIP_METHOD') {
        req.flash?.('error', 'No shipping method available.');
        return res.redirect('/cart/checkout');
      }
      return next(err || new Error(code));
    });
  };

  conn.beginTransaction((txErr) => {
    if (txErr) return rollback('BEGIN_FAIL', txErr);

    const selectedAddressId = req.session?.selectedAddressId || null;
    const addressSql = 'SELECT id FROM delivery_addresses WHERE user_id = ? ORDER BY (id = ?) DESC, is_default DESC, id ASC LIMIT 1';
    conn.query(addressSql, [userId, selectedAddressId || 0], (addrErr, addrRows = []) => {
      if (addrErr) return rollback('NO_ADDRESS', addrErr);
      if (!addrRows.length) return rollback('NO_ADDRESS');
      const deliveryAddressId = addrRows[0].id;

      const selectedShippingMethodId = req.session?.selectedShippingMethodId || null;
      const pickShipping = () => new Promise((resolve, reject) => {
        if (!selectedShippingMethodId) {
          return conn.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (sErr, sRows = []) => {
            if (sErr) return reject(sErr);
            if (!sRows.length) return reject(new Error('NO_SHIP_METHOD'));
            return resolve(sRows[0]);
          });
        }

        conn.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [selectedShippingMethodId], (sErr, sRows = []) => {
          if (sErr) return reject(sErr);
          if (sRows.length) return resolve(sRows[0]);
          conn.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (fErr, fRows = []) => {
            if (fErr) return reject(fErr);
            if (!fRows.length) return reject(new Error('NO_SHIP_METHOD'));
            return resolve(fRows[0]);
          });
        });
      });

      pickShipping().then((shipRow) => {
        const shippingMethodId = shipRow.id;
        const shippingFee = Number(shipRow.price || 0);

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

          const itemsTotal = cartRows.reduce(
            (sum, row) => sum + Number(row.price || 0) * Number(row.cart_qty || 0),
            0
          );
          const totalAmount = itemsTotal + shippingFee;

          conn.query(
            'INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, NOW(), ?, "Pending", NOW())',
            [userId, deliveryAddressId, shippingMethodId, shippingFee, totalAmount],
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
                          const encodedAmount = encodeURIComponent(totalAmount || '');
                          return res.redirect(`/payment/success?orderId=${orderId}&method=card&amount=${encodedAmount}`);
                        });
                      });
                    })
                    .catch((decErr) => rollback('DECREMENT_FAIL', decErr));
                }
              );
            }
          );
        });
      }).catch((shipErr) => rollback(shipErr.message === 'NO_SHIP_METHOD' ? 'NO_SHIP_METHOD' : 'NO_SHIP_METHOD', shipErr));
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

      const addressPromise = new Promise((resolve) => {
        if (!order.delivery_address_id) return resolve(null);
        db.query('SELECT * FROM delivery_addresses WHERE id = ? LIMIT 1', [order.delivery_address_id], (aErr, aRows = []) => {
          if (aErr) { console.error('load delivery address error', aErr); return resolve(null); }
          resolve(aRows[0] || null);
        });
      });

      const shippingPromise = new Promise((resolve) => {
        if (!order.shipping_method_id) return resolve(null);
        db.query('SELECT * FROM shipping_methods WHERE id = ? LIMIT 1', [order.shipping_method_id], (sErr, sRows = []) => {
          if (sErr) { console.error('load shipping method error', sErr); return resolve(null); }
          resolve(sRows[0] || null);
        });
      });

      const paymentPromise = new Promise((resolve) => {
        // Prefer explicit order.payment_method if present
        if (order.payment_method) return resolve(order.payment_method);
        // Next, check paypal_transactions
        db.query('SELECT paypal_order_id FROM paypal_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId], (pErr, pRows = []) => {
          if (!pErr && pRows && pRows[0]) return resolve('PayPal');
          // Next, check nets_transactions
          db.query('SELECT nets_txn_id FROM nets_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId], (nErr, nRows = []) => {
            if (!nErr && nRows && nRows[0]) return resolve('NETS QR');
            // Fallback to request query param or Card
            return resolve(req.query?.method || 'Card');
          });
        });
      });

      Promise.all([addressPromise, shippingPromise, paymentPromise]).then(([deliveryAddress, shippingMethod, detectedPaymentMethod]) => {
        const itemsSubtotal = items.reduce((sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0), 0);
        const shippingFee = Number(order.shipping_fee || 0);
        const data = {
          orderId: order.id,
          createdAt: order.createdAt || order.orderDate,
          items,
          itemsSubtotal,
          shippingFee,
          totalAmount: Number(order.totalAmount != null ? order.totalAmount : (itemsSubtotal + shippingFee)),
          deliveryAddress,
          shippingMethod,
          paymentMethod: order.payment_method || req.query?.method || detectedPaymentMethod || 'Card',
          userName: sessionUser?.username || sessionUser?.name || sessionUser?.email,
          userAddress: sessionUser?.address || '',
          userPhone: sessionUser?.contact || sessionUser?.phone || ''
        };

        // support download as PDF when ?download=pdf or ?pdf=1 is present
        const wantsPdf = (req.query && (String(req.query.download || '').toLowerCase() === 'pdf' || String(req.query.pdf || '') === '1' || String(req.query.pdf || '').toLowerCase() === 'true'));
        if (wantsPdf) {
          return res.render('receipt', data, async (err, html) => {
            if (err) { console.error('render receipt for pdf error', err); return res.status(500).send('Failed to render receipt'); }
            try {
              // try to use puppeteer if available
              const puppeteer = require('puppeteer');
              const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
              const page = await browser.newPage();
              await page.setContent(html, { waitUntil: 'networkidle0' });
              const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
              await browser.close();
              res.setHeader('Content-Type', 'application/pdf');
              res.setHeader('Content-Disposition', `attachment; filename=receipt-${order.id}.pdf`);
              return res.send(pdfBuffer);
            } catch (pdfErr) {
              console.error('PDF generation failed, falling back to HTML attachment', pdfErr);
              res.setHeader('Content-Disposition', `attachment; filename=receipt-${order.id}.html`);
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              return res.send(html);
            }
          });
        }

        return res.render('receipt', data);
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

    const orders = rows || [];
    const orderIds = orders.map(o => o.id).filter(Boolean);
    if (!orderIds.length) {
      return res.render('orderHistory', {
        orders,
        pageTitle: 'Current Orders',
        showDelivered: false,
        user: sessionUser,
        isAdmin: sessionUser?.role === 'admin'
      });
    }

    const itemsSql = `
      SELECT oi.order_id, oi.quantity AS qty, oi.price, p.productName, p.image
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (?)
    `;
    db.query(itemsSql, [orderIds], (iErr, itemRows = []) => {
      if (iErr) { console.error(iErr); /* fall back to rendering without items */ }
      const itemsByOrder = (itemRows || []).reduce((acc, r) => {
        const id = r.order_id;
        acc[id] = acc[id] || [];
        acc[id].push({ name: r.productName || r.product_name || '', qty: r.qty || r.quantity || 0, price: Number(r.price || 0), image: r.image || r.product_image || '' });
        return acc;
      }, {});

      orders.forEach(o => { o.items = itemsByOrder[o.id] || []; });

      return res.render('orderHistory', {
        orders,
        pageTitle: 'Current Orders',
        showDelivered: false,
        user: sessionUser,
        isAdmin: sessionUser?.role === 'admin'
      });
    });
  });
}

function orderHistoryPage(req, res) {
  const sessionUser = req.session?.user;
  const userId = sessionUser?.id || req.session?.userId;
  if (!userId) return res.redirect('/login');

  db.query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [userId], (err, rows = []) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load orders'); }

    const orders = rows || [];
    const orderIds = orders.map(o => o.id).filter(Boolean);
    if (!orderIds.length) {
      return res.render('orderHistory', {
        orders,
        pageTitle: 'Order History',
        showDelivered: true,
        user: sessionUser,
        isAdmin: sessionUser?.role === 'admin'
      });
    }

    const itemsSql = `
      SELECT oi.order_id, oi.quantity AS qty, oi.price, p.productName
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (?)
    `;
    db.query(itemsSql, [orderIds], (iErr, itemRows = []) => {
      if (iErr) { console.error(iErr); }
      const itemsByOrder = (itemRows || []).reduce((acc, r) => {
        const id = r.order_id;
        acc[id] = acc[id] || [];
        acc[id].push({ name: r.productName || r.product_name || '', qty: r.qty || r.quantity || 0, price: Number(r.price || 0) });
        return acc;
      }, {});

      // Load refund status for each order
      const refundSql = `
        SELECT order_id, id, status, amount, createdAt, admin_note
        FROM refunds
        WHERE order_id IN (?)
        ORDER BY createdAt DESC
      `;
      db.query(refundSql, [orderIds], (rErr, refundRows = []) => {
        if (rErr) { console.error('Error loading refunds:', rErr); }
        
        const refundsByOrder = (refundRows || []).reduce((acc, r) => {
          acc[r.order_id] = r;
          return acc;
        }, {});

        orders.forEach(o => { 
          o.items = itemsByOrder[o.id] || [];
          o.refund = refundsByOrder[o.id] || null;
        });

        return res.render('orderHistory', {
          orders,
          pageTitle: 'Order History',
          showDelivered: true,
          user: sessionUser,
          isAdmin: sessionUser?.role === 'admin'
        });
      });
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
  paymentSuccess,
  adminList: exports.adminList,
  adminDetails: exports.adminDetails
};

// Render payment success page with masked method and order info
function paymentSuccess(req, res) {
  const sessionUser = req.session?.user;
  if (!sessionUser) return res.redirect('/login');

  const userId = sessionUser.id || req.session?.userId;
  const { orderId, method, txn, last4, amount } = req.query || {};

  const renderPage = (opts = {}) => {
    return res.render('paymentSuccess', {
      transactionId: opts.transactionId || txn || null,
      date: opts.date || (new Date()).toLocaleString(),
      paymentMethod: opts.paymentMethod || (method === 'paypal' ? 'PayPal' : (method === 'card' ? 'Card' : method)),
      maskedCard: opts.maskedCard || (last4 ? ('**** ' + String(last4).slice(-4)) : null),
      amount: opts.amount || amount || null,
      orderId: opts.orderId || orderId || null
    });
  };

  if (!orderId) return renderPage();

  // load order to confirm ownership and get createdAt / total
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId], (err, rows) => {
    if (err) { console.error('paymentSuccess - db error', err); return res.status(500).send('Failed to load order'); }
    const order = rows && rows[0];
    if (!order) return res.status(404).send('Order not found');

    if (Number(order.user_id) !== Number(userId) && !(sessionUser.role === 'admin')) {
      return res.status(403).send('Forbidden');
    }

    const opts = {};
    opts.amount = opts.amount || order.totalAmount;
    opts.date = new Date(order.createdAt || order.orderDate || Date.now()).toLocaleString();

    if (method === 'paypal') {
      // try to fetch stored paypal transaction for nicer txn id/date
      db.query('SELECT paypal_order_id, payment_time FROM paypal_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId], (pErr, pRows) => {
        if (!pErr && pRows && pRows[0]) {
          opts.transactionId = pRows[0].paypal_order_id || txn || '';
          if (pRows[0].payment_time) opts.date = new Date(pRows[0].payment_time).toLocaleString();
        }
        return renderPage({ transactionId: opts.transactionId, date: opts.date, paymentMethod: 'PayPal', maskedCard: null, amount: opts.amount });
      });
      return;
    }

    // card or other (use last4 if provided)
    opts.transactionId = txn || null;
    opts.maskedCard = last4 ? ('**** ' + String(last4).slice(-4)) : null;
    return renderPage({ transactionId: opts.transactionId, date: opts.date, paymentMethod: method === 'card' ? 'Card' : method, maskedCard: opts.maskedCard, amount: opts.amount });
  });
}

// (Removed duplicate/older showReceipt implementation. The updated `showReceipt` above loads delivery address and shipping method from `orders` and passes them into the `receipt` view.)

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
  paymentSuccess,
  adminList: exports.adminList,
  adminDetails: exports.adminDetails
};