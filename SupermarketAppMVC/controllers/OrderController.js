const Order = require('../models/Order');
const OrderItem = require('../models/Order_Item');
const Cart = require('../models/Cart');
const LoyaltyPointsController = require('./LoyaltyPointsController');
const db = require('../db');
const Membership = require('../models/Membership');

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

      const createdAt = new Date();

      // resolve shipping method (session selection or default)
      const selectedShippingMethodId = req.session?.selectedShippingMethodId || null;
      const pickShipping = (cb) => {
        if (!selectedShippingMethodId) {
          return db.query('SELECT id, method_name, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (sErr, sRows = []) => {
            if (sErr) return cb(sErr);
            if (!sRows.length) return cb(new Error('NO_SHIP_METHOD'));
            return cb(null, sRows[0]);
          });
        }
        db.query('SELECT id, method_name, price FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [selectedShippingMethodId], (sErr, sRows = []) => {
          if (sErr) return cb(sErr);
          if (sRows && sRows[0]) return cb(null, sRows[0]);
          return db.query('SELECT id, method_name, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (fErr, fRows = []) => {
            if (fErr) return cb(fErr);
            if (!fRows.length) return cb(new Error('NO_SHIP_METHOD'));
            return cb(null, fRows[0]);
          });
        });
      };

      const itemsTotal = items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.quantity || it.qty || 0)), 0);

      pickShipping((sErr, shipRow) => {
        if (sErr) {
          console.error('placeOrder shipping resolution error', sErr);
          // fallback: create order without shipping info
          const insertOrderSql = 'INSERT INTO orders (user_id, totalAmount, createdAt) VALUES (?, ?, ?)';
          return db.query(insertOrderSql, [userId, itemsTotal, createdAt], (oErr, oRes) => {
            if (oErr) { console.error(oErr); return res.status(500).send('Failed to create order'); }
            const orderId = oRes && (oRes.insertId || (Array.isArray(oRes) && oRes[0] && oRes[0].insertId));
            return proceedInsertItems(orderId, items, createdAt);
          });
        }

        const originalShippingFee = Number(shipRow.price || 0);

        // apply membership perks
        Membership.getUserMembership(userId, (mErr, membership) => {
          if (mErr) console.error('placeOrder - membership fetch error', mErr);
          if (!membership) membership = { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 };

          let appliedShippingFee = originalShippingFee;
          const methodName = String(shipRow?.method_name || '').toLowerCase();
          const isStandard = methodName.includes('standard');
          const isPriority = methodName.includes('priority');

          if (isStandard && (membership.free_standard_delivery || (itemsTotal >= Number(membership.free_delivery_threshold || 0)))) {
            appliedShippingFee = 0;
          }
          if (isPriority && Number(membership.priority_delivery_discount || 0) > 0) {
            appliedShippingFee = Math.max(0, originalShippingFee - Number(membership.priority_delivery_discount || 0));
          }

          let discountAmount = 0;
          const discThresh = Number(membership.discount_threshold || 0);
          const discPercent = Number(membership.discount_percent || 0);
          if (discPercent > 0 && itemsTotal >= discThresh) {
            discountAmount = Number((itemsTotal * (discPercent / 100)).toFixed(2));
          }

          const totalWithShipping = Number((itemsTotal + appliedShippingFee - discountAmount).toFixed(2));

          // insert order with shipping and total
          const insertOrderSql = 'INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, totalAmount, createdAt) VALUES (?, ?, ?, ?, ?, ?)';
          db.query(insertOrderSql, [userId, null, shipRow.id, appliedShippingFee, totalWithShipping, createdAt], (oErr, oRes) => {
            if (oErr) { console.error(oErr); return res.status(500).send('Failed to create order'); }
            const orderId = oRes && (oRes.insertId || (Array.isArray(oRes) && oRes[0] && oRes[0].insertId));
            return proceedInsertItems(orderId, items, createdAt);
          });
        });
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

// Checkout: create order from cart_items, apply membership perks, insert order_items, clear cart_items
const checkout = function (req, res, next) {
  const userId = req.session?.user?.id || req.session?.userId;
  if (!userId) return res.redirect('/login');

  const conn = db;
  const release = () => { if (typeof conn.release === 'function') conn.release(); };
  const rollback = (code, err) => {
    try { conn.rollback(() => {}); } catch (e) {}
    release();
    console.error('checkout:', code, err || '');
    if (code === 'EMPTY_CART') { if (req.flash) req.flash('error', 'Your cart is empty.'); return res.redirect('/cart'); }
    if (code === 'OUT_OF_STOCK') { if (req.flash) req.flash('error', 'Not enough stock for one or more items.'); return res.redirect('/cart'); }
    if (code === 'NO_ADDRESS') { if (req.flash) req.flash('error', 'Please add a delivery address.'); return res.redirect('/cart/checkout'); }
    if (code === 'NO_SHIP_METHOD') { if (req.flash) req.flash('error', 'No shipping method available.'); return res.redirect('/cart/checkout'); }
    return next(err || new Error(code));
  };

  conn.beginTransaction((txErr) => {
    if (txErr) return rollback('BEGIN_FAIL', txErr);

    const selectedAddressId = req.session?.selectedAddressId || null;
    const selectedShippingMethodId = req.session?.selectedShippingMethodId || null;

    conn.query('SELECT COUNT(*) AS cnt FROM delivery_addresses WHERE user_id = ?', [userId], (countErr, countRows = []) => {
      if (countErr) return rollback('NO_ADDRESS', countErr);
      const addrCount = Number(countRows && countRows[0] && countRows[0].cnt) || 0;
      if (addrCount > 0 && !selectedAddressId) return rollback('NO_ADDRESS_SELECTED');

      conn.query('SELECT COUNT(*) AS cnt FROM shipping_methods WHERE is_active = 1', [], (scErr, scRows = []) => {
        if (scErr) return rollback('NO_SHIP_METHOD', scErr);
        const shipCount = Number(scRows && scRows[0] && scRows[0].cnt) || 0;
        if (shipCount > 0 && !selectedShippingMethodId) return rollback('NO_SHIP_SELECTED');

        const addressSql = 'SELECT id FROM delivery_addresses WHERE user_id = ? ORDER BY (id = ?) DESC, is_default DESC, id ASC LIMIT 1';
        conn.query(addressSql, [userId, selectedAddressId || 0], (addrErr, addrRows = []) => {
          if (addrErr) return rollback('NO_ADDRESS', addrErr);
          if (!addrRows.length) return rollback('NO_ADDRESS');
          const deliveryAddressId = addrRows[0].id;

          const pickShipping = () => new Promise((resolve, reject) => {
            if (!selectedShippingMethodId) {
              return conn.query('SELECT id, method_name, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (sErr, sRows = []) => {
                if (sErr) return reject(sErr);
                if (!sRows.length) return reject(new Error('NO_SHIP_METHOD'));
                return resolve(sRows[0]);
              });
            }
            conn.query('SELECT id, method_name, price FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [selectedShippingMethodId], (sErr, sRows = []) => {
              if (sErr) return reject(sErr);
              if (sRows.length) return resolve(sRows[0]);
              conn.query('SELECT id, method_name, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (fErr, fRows = []) => {
                if (fErr) return reject(fErr);
                if (!fRows.length) return reject(new Error('NO_SHIP_METHOD'));
                return resolve(fRows[0]);
              });
            });
          });

          pickShipping().then((shipRow) => {
            const shippingMethodId = shipRow.id;
            const originalShippingFee = Number(shipRow.price || 0);

            // Respect any selected cart item ids saved in session (from cart page)
            let cartSql = 'SELECT ci.id AS cart_id, ci.product_id, ci.quantity AS cart_qty, p.quantity AS stock_qty, p.price FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ?';
            const cartParams = [userId];
            const sel = req.session?.selectedCartItemIds;
            if (Array.isArray(sel) && sel.length) {
              cartSql += ' AND ci.id IN (?)';
              cartParams.push(sel);
            }
            cartSql += ' FOR UPDATE';

            conn.query(cartSql, cartParams, (cartErr, cartRows = []) => {
              if (cartErr) return rollback('LOAD_CART_FAIL', cartErr);
              if (!cartRows.length) return rollback('EMPTY_CART');

              const insufficient = cartRows.find(r => Number(r.cart_qty) > Number(r.stock_qty));
              if (insufficient) return rollback('OUT_OF_STOCK');

              const itemsTotal = cartRows.reduce((s, r) => s + Number(r.price || 0) * Number(r.cart_qty || 0), 0);

              Membership.getUserMembership(userId, (mErr, membership) => {
                if (mErr) console.error('checkout - membership fetch error', mErr);
                if (!membership) membership = { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 };

                let appliedShippingFee = originalShippingFee;
                const methodName = String(shipRow?.method_name || '').toLowerCase();
                const isStandard = methodName.includes('standard');
                const isPriority = methodName.includes('priority');

                if (isStandard && (membership.free_standard_delivery || (itemsTotal >= Number(membership.free_delivery_threshold || 0)))) {
                  appliedShippingFee = 0;
                }
                if (isPriority && Number(membership.priority_delivery_discount || 0) > 0) {
                  appliedShippingFee = Math.max(0, originalShippingFee - Number(membership.priority_delivery_discount));
                }

                let discountAmount = 0;
                const discThresh = Number(membership.discount_threshold || 0);
                const discPercent = Number(membership.discount_percent || 0);
                if (discPercent > 0 && itemsTotal >= discThresh) {
                  discountAmount = Number((itemsTotal * (discPercent / 100)).toFixed(2));
                }

                // handle applied coupon from session (re-validate server-side)
                let couponDiscount = 0;
                let appliedCoupon = (req.session && req.session.appliedCoupon) ? req.session.appliedCoupon : null;

                function finalizeOrderWithCoupon(couponDiscountAmount, userCouponIdToMark) {
                  const totalAmount = Number((itemsTotal + appliedShippingFee - discountAmount - (couponDiscountAmount || 0)).toFixed(2));

                  // include coupon fields in the orders table (coupon_id, coupon_code_snapshot, coupon_discount)
                  const couponIdToStore = (appliedCoupon && appliedCoupon.coupon_id) ? appliedCoupon.coupon_id : null;
                  const couponCodeSnapshot = (appliedCoupon && appliedCoupon.code) ? appliedCoupon.code : null;

                  conn.query('INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, coupon_id, coupon_code_snapshot, coupon_discount, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, "Pending", NOW())', [userId, deliveryAddressId, shippingMethodId, appliedShippingFee, couponIdToStore, couponCodeSnapshot, (couponDiscountAmount || 0), totalAmount], (orderErr, orderRes) => {
                    if (orderErr) {
                      if (orderErr && orderErr.code === 'ER_BAD_FIELD_ERROR') {
                        console.warn('OrderController.checkout: orders table missing coupon columns, retrying without coupon fields');
                        return conn.query('INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, NOW(), ?, "Pending", NOW())', [userId, deliveryAddressId, shippingMethodId, appliedShippingFee, totalAmount], (o2Err, o2Res) => {
                          if (o2Err) return rollback('INSERT_ORDER_FAIL', o2Err);
                          const orderId = o2Res.insertId;
                          // continue with same logic as successful insert
                          const valuesSql = cartRows.map(() => '(?, ?, ?, ?, NOW())').join(',');
                          const valuesParams = cartRows.flatMap(row => [orderId, row.product_id, Number(row.cart_qty), Number(row.price || 0)]);

                          conn.query('INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES ' + valuesSql, valuesParams, (itemsErr) => {
                            if (itemsErr) return rollback('INSERT_ITEMS_FAIL', itemsErr);
                            const stockPromises = cartRows.map(row => new Promise((resolve, reject) => {
                              conn.query('UPDATE products SET quantity = quantity - ? WHERE id = ?', [Number(row.cart_qty), row.product_id], (uErr) => (uErr ? reject(uErr) : resolve()));
                            }));

                            Promise.all(stockPromises).then(() => {
                              const markUserCoupon = userCouponIdToMark ? new Promise((resolve, reject) => {
                                conn.query('UPDATE user_coupons SET status = "USED", used_at = NOW() WHERE id = ? AND status = "ASSIGNED"', [userCouponIdToMark], (ucErr) => {
                                  if (ucErr) { console.error('mark user_coupon used error', ucErr); return resolve(); }
                                  return resolve();
                                });
                              }) : Promise.resolve();

                              markUserCoupon.then(() => {
                                // additionally mark global coupon as used (single-use) if applicable
                                const markGlobal = (req.session && req.session.appliedCoupon && req.session.appliedCoupon.coupon_id && Number(req.session.appliedCoupon.is_global || 0)) ? new Promise((resolve) => {
                                  conn.query('UPDATE coupons SET is_active = 0, used_at = NOW() WHERE id = ? AND is_active = 1', [req.session.appliedCoupon.coupon_id], (cErr) => {
                                    if (cErr) console.error('mark global coupon used error', cErr);
                                    return resolve();
                                  });
                                }) : Promise.resolve();

                                markGlobal.then(() => {
                                  conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (clearErr) => {
                                    if (clearErr) return rollback('CLEAR_CART_FAIL', clearErr);
                                    conn.commit((commitErr) => {
                                      if (commitErr) return rollback('COMMIT_FAIL', commitErr);
                                      release();
                                      const encodedAmount = encodeURIComponent(totalAmount || '');
                                      return res.redirect('/payment/success?orderId=' + orderId + '&method=card&amount=' + encodedAmount);
                                    });
                                  });
                                });
                              }).catch((mErr) => {
                                console.error('markUserCoupon error', mErr);
                                return rollback('COUPON_MARK_FAIL', mErr);
                              });
                            }).catch((decErr) => rollback('DECREMENT_FAIL', decErr));
                          });
                        });
                      }
                      return rollback('INSERT_ORDER_FAIL', orderErr);
                    }
                    const orderId = orderRes.insertId;

                    const valuesSql = cartRows.map(() => '(?, ?, ?, ?, NOW())').join(',');
                    const valuesParams = cartRows.flatMap(row => [orderId, row.product_id, Number(row.cart_qty), Number(row.price || 0)]);

                    conn.query('INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES ' + valuesSql, valuesParams, (itemsErr) => {
                      if (itemsErr) return rollback('INSERT_ITEMS_FAIL', itemsErr);

                      const stockPromises = cartRows.map(row => new Promise((resolve, reject) => {
                        conn.query('UPDATE products SET quantity = quantity - ? WHERE id = ?', [Number(row.cart_qty), row.product_id], (uErr) => (uErr ? reject(uErr) : resolve()));
                      }));

                      Promise.all(stockPromises).then(() => {
                        // mark user_coupon as used if applicable
                        const markUserCoupon = userCouponIdToMark ? new Promise((resolve, reject) => {
                          conn.query('UPDATE user_coupons SET status = "USED", used_at = NOW() WHERE id = ? AND status = "ASSIGNED"', [userCouponIdToMark], (ucErr) => {
                            if (ucErr) { console.error('mark user_coupon used error', ucErr); return resolve(); }
                            return resolve();
                          });
                        }) : Promise.resolve();

                        markUserCoupon.then(() => {
                          // additionally mark global coupon as used (single-use) if applicable
                          const markGlobal = (req.session && req.session.appliedCoupon && req.session.appliedCoupon.coupon_id && Number(req.session.appliedCoupon.is_global || 0)) ? new Promise((resolve) => {
                            conn.query('UPDATE coupons SET is_active = 0, used_at = NOW() WHERE id = ? AND is_active = 1', [req.session.appliedCoupon.coupon_id], (cErr) => {
                              if (cErr) console.error('mark global coupon used error', cErr);
                              return resolve();
                            });
                          }) : Promise.resolve();

                          markGlobal.then(() => {
                            conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (clearErr) => {
                              if (clearErr) return rollback('CLEAR_CART_FAIL', clearErr);
                              conn.commit((commitErr) => {
                                if (commitErr) return rollback('COMMIT_FAIL', commitErr);
                                release();
                                const encodedAmount = encodeURIComponent(totalAmount || '');
                                return res.redirect('/payment/success?orderId=' + orderId + '&method=card&amount=' + encodedAmount);
                              });
                            });
                          });
                        }).catch((mErr) => {
                          console.error('markUserCoupon error', mErr);
                          return rollback('COUPON_MARK_FAIL', mErr);
                        });
                      }).catch((decErr) => rollback('DECREMENT_FAIL', decErr));
                    });
                  });
                }

                if (appliedCoupon && appliedCoupon.coupon_id) {
                  // re-validate coupon from DB
                  conn.query('SELECT * FROM coupons WHERE id = ? LIMIT 1', [appliedCoupon.coupon_id], (ccErr, ccRows = []) => {
                    if (ccErr) { console.error('checkout - coupon lookup error', ccErr); appliedCoupon = null; return finalizeOrderWithCoupon(0, null); }
                    if (!ccRows || !ccRows.length) { try { if (req.session) req.session.appliedCoupon = null; } catch(e){}; return finalizeOrderWithCoupon(0, null); }
                    const couponRow = ccRows[0];
                    // persist whether coupon is global/active to the session-appliedCoupon so later flows can mark usage
                    try {
                      if (req.session && req.session.appliedCoupon) {
                        req.session.appliedCoupon.is_global = Number(couponRow.is_global || 0);
                        req.session.appliedCoupon.is_active = (typeof couponRow.is_active !== 'undefined') ? Number(couponRow.is_active || 0) : 1;
                      }
                    } catch (e) { /* ignore session write errors */ }
                    const now = new Date();
                    if (couponRow.valid_from && new Date(couponRow.valid_from) > now) { try { if (req.session) req.session.appliedCoupon = null; } catch(e){}; return finalizeOrderWithCoupon(0, null); }
                    if (couponRow.valid_until && new Date(couponRow.valid_until) < now) { try { if (req.session) req.session.appliedCoupon = null; } catch(e){}; return finalizeOrderWithCoupon(0, null); }

                    // enforce min spend and user assignment if needed
                    const requiredMin = Number(couponRow.min_spend || 0);
                    if (requiredMin > 0 && itemsTotal < requiredMin) { try { if (req.session) req.session.appliedCoupon = null; } catch(e){}; return finalizeOrderWithCoupon(0, null); }

                    if (!Number(couponRow.is_global)) {
                      // ensure user coupon still assigned
                      const userCouponId = appliedCoupon.user_coupon_id || null;
                      if (!userCouponId) { try { if (req.session) req.session.appliedCoupon = null; } catch(e){}; return finalizeOrderWithCoupon(0, null); }
                      conn.query('SELECT * FROM user_coupons WHERE id = ? AND user_id = ? AND status = "ASSIGNED" LIMIT 1', [userCouponId, userId], (uc2Err, uc2Rows = []) => {
                        if (uc2Err) { console.error('checkout - user_coupons lookup error', uc2Err); return finalizeOrderWithCoupon(0, null); }
                        if (!uc2Rows || !uc2Rows.length) { try { if (req.session) req.session.appliedCoupon = null; } catch(e){}; return finalizeOrderWithCoupon(0, null); }

                        // calculate discount
                        let cd = 0;
                        if (couponRow.discount_type === 'PERCENTAGE') cd = Number((itemsTotal * (Number(couponRow.discount_value || 0) / 100)).toFixed(2));
                        else cd = Number(couponRow.discount_value || 0);
                        if (cd > itemsTotal) cd = itemsTotal;
                        return finalizeOrderWithCoupon(cd, userCouponId);
                      });
                    } else {
                      let cd = 0;
                      if (couponRow.discount_type === 'PERCENTAGE') cd = Number((itemsTotal * (Number(couponRow.discount_value || 0) / 100)).toFixed(2));
                      else cd = Number(couponRow.discount_value || 0);
                      if (cd > itemsTotal) cd = itemsTotal;
                      return finalizeOrderWithCoupon(cd, appliedCoupon.user_coupon_id || null);
                    }
                  });
                } else {
                  // no coupon applied
                  finalizeOrderWithCoupon(0, null);
                }
              });
            });
          }).catch((shipErr) => rollback('NO_SHIP_METHOD', shipErr));
        });
      });
    });
  });
};

exports.checkout = checkout;

// Apply coupon (AJAX)
function applyCoupon(req, res) {
  try {
    const userId = req.session?.user?.id || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated' });
    const code = (req.body && (req.body.code || req.body.coupon || req.body.coupon_code)) ? String(req.body.code || req.body.coupon || req.body.coupon_code).trim() : null;
    if (!code) return res.json({ success: false, message: 'Coupon code required' });

    // load coupon
    db.query('SELECT * FROM coupons WHERE coupon_code = ? LIMIT 1', [code], (cErr, cRows = []) => {
      if (cErr) { console.error('applyCoupon - coupon query error', cErr); return res.status(500).json({ success: false, message: 'Internal error' }); }
      if (!cRows || !cRows.length) return res.json({ success: false, message: 'Invalid coupon code' });
      const coupon = cRows[0];

      const now = new Date();
      if (coupon.valid_from && new Date(coupon.valid_from) > now) return res.json({ success: false, message: 'Coupon not active yet' });
      if (coupon.valid_until && new Date(coupon.valid_until) < now) return res.json({ success: false, message: 'Coupon expired' });

      // If coupon is not global, ensure user has assigned coupon
      if (!Number(coupon.is_global)) {
        db.query('SELECT * FROM user_coupons WHERE user_id = ? AND coupon_id = ? AND coupon_code = ? AND status = "ASSIGNED" LIMIT 1', [userId, coupon.id, coupon.coupon_code], (ucErr, ucRows = []) => {
          if (ucErr) { console.error('applyCoupon - user_coupons query error', ucErr); return res.status(500).json({ success: false, message: 'Internal error' }); }
          if (!ucRows || !ucRows.length) return res.json({ success: false, message: 'Coupon not assigned to this user' });
          const userCoupon = ucRows[0];
          return continueWithCartTotal(userCoupon.min_spend || coupon.min_spend, userCoupon.id);
        });
      } else {
        // For global coupons, ensure this user hasn't used it before
        db.query('SELECT * FROM user_coupons WHERE user_id = ? AND coupon_id = ? AND status = "USED" LIMIT 1', [userId, coupon.id], (usedErr, usedRows = []) => {
          if (usedErr) { console.error('applyCoupon - user usage lookup error', usedErr); return res.status(500).json({ success: false, message: 'Internal error' }); }
          if (usedRows && usedRows.length) return res.json({ success: false, message: 'Coupon already used by this user' });
          return continueWithCartTotal(coupon.min_spend || 0, null);
        });
      }

      function continueWithCartTotal(requiredMinSpend, userCouponId) {
        // compute cart subtotal (respect selectedCartItemIds in session)
        let cartSql = 'SELECT ci.quantity AS qty, p.price FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ?';
        const params = [userId];
        const sel = req.session?.selectedCartItemIds;
        if (Array.isArray(sel) && sel.length) { cartSql += ' AND ci.id IN (?)'; params.push(sel); }
        db.query(cartSql, params, (cartErr, cartRows = []) => {
          if (cartErr) { console.error('applyCoupon - cart query error', cartErr); return res.status(500).json({ success: false, message: 'Internal error' }); }
          if (!cartRows || !cartRows.length) return res.json({ success: false, message: 'Your cart is empty' });
          const itemsTotal = cartRows.reduce((s, r) => s + Number(r.price || 0) * Number(r.qty || r.quantity || 0), 0);
          if (Number(requiredMinSpend || 0) > 0 && itemsTotal < Number(requiredMinSpend)) {
            const shortfall = Number((Number(requiredMinSpend) - Number(itemsTotal)).toFixed(2));
            return res.json({ success: false, message: `Minimum spend $${Number(requiredMinSpend).toFixed(2)} required to use this coupon`, amountNeeded: shortfall, minSpend: Number(requiredMinSpend) });
          }

          let discount = 0;
          if (coupon.discount_type === 'PERCENTAGE') {
            discount = Number((itemsTotal * (Number(coupon.discount_value || 0) / 100)).toFixed(2));
          } else {
            discount = Number(coupon.discount_value || 0);
          }
          if (discount > itemsTotal) discount = itemsTotal;

          const newTotal = Number((itemsTotal - discount).toFixed(2));
          // store applied coupon in session so final order placement can access it
          try { if (req.session) req.session.appliedCoupon = { coupon_id: coupon.id, user_coupon_id: userCouponId, code: coupon.coupon_code, discount: discount, is_global: Number(coupon.is_global || 0), is_active: (typeof coupon.is_active !== 'undefined') ? Number(coupon.is_active || 0) : 1 }; } catch (e) { /* ignore session write errors */ }
          return res.json({ success: true, discount: discount, subtotal: Number(itemsTotal.toFixed(2)), newTotal: newTotal, coupon: { id: coupon.id, code: coupon.coupon_code, type: coupon.discount_type, value: Number(coupon.discount_value) }, userCouponId: userCouponId });
        });
      }
    });
  } catch (err) {
    console.error('applyCoupon error', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

exports.applyCoupon = applyCoupon;

// Remove applied coupon from session (AJAX)
function removeCoupon(req, res) {
  try {
    if (req.session) req.session.appliedCoupon = null;
    return res.json({ success: true });
  } catch (err) {
    console.error('removeCoupon error', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
}

exports.removeCoupon = removeCoupon;

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

          // compute membership discount (if any) so invoice shows breakdown
          Membership.getUserMembership(sessionUser?.id || req.session?.userId, (mErr, membership) => {
            if (mErr) console.error('membership lookup for receipt failed', mErr);
            if (!membership) membership = { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 };
            const discPercent = Number(membership.discount_percent || 0);
            const discThresh = Number(membership.discount_threshold || 0);
            let discountAmount = 0;
            if (discPercent > 0 && itemsSubtotal >= discThresh) discountAmount = Number((itemsSubtotal * (discPercent / 100)).toFixed(2));

            const originalShippingFee = Number(shippingMethod && (shippingMethod.price || shippingMethod.price) ? Number(shippingMethod.price) : shippingFee);
            const data = {
              orderId: order.id,
              createdAt: order.createdAt || order.orderDate,
              items,
              itemsSubtotal,
              shippingFee,
              originalShippingFee,
              discountAmount,
              membershipName: membership.plan_name || 'Free',
              totalAmount: Number(order.totalAmount != null ? order.totalAmount : (itemsSubtotal + shippingFee - discountAmount)),
              couponCode: order.coupon_code_snapshot || null,
              couponDiscount: Number(order.coupon_discount || 0),
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
  paymentSuccess
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

  // Render page but include any points earned for this order (if present)
  const renderPageWithPoints = (opts = {}) => {
    const oid = opts.orderId || orderId || null;
    if (!oid) return renderPage(opts);
    db.query('SELECT SUM(points) AS pts FROM loyalty_points_transactions WHERE order_id = ? AND type = "EARN"', [oid], (err, rows = []) => {
      const pts = (rows && rows[0] && Number(rows[0].pts)) || 0;
      const merged = Object.assign({}, opts, { pointsEarned: pts });
      return res.render('paymentSuccess', {
        transactionId: merged.transactionId || txn || null,
        date: merged.date || (new Date()).toLocaleString(),
        paymentMethod: merged.paymentMethod || (method === 'paypal' ? 'PayPal' : (method === 'card' ? 'Card' : method)),
        maskedCard: merged.maskedCard || (last4 ? ('**** ' + String(last4).slice(-4)) : null),
        amount: merged.amount || amount || null,
        orderId: merged.orderId || orderId || null,
        pointsEarned: merged.pointsEarned || 0
      });
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

    // Award loyalty points synchronously (callback) to avoid race with rendering
    const awardPointsAndThen = (cb) => {
      const userIdNum = Number(userId);
      const orderTotal = Number(order.totalAmount || opts.amount || 0);
      
      // Use LoyaltyPointsController to award points
      LoyaltyPointsController.awardPointsForOrder(userIdNum, orderId, orderTotal, (err, result) => {
        if (err) {
          console.error('Points awarding error:', err);
          return cb(0);
        }
        const pointsEarned = (result && result.points) || 0;
        return cb(pointsEarned);
      });
    };


    if (method === 'paypal') {
      // try to fetch stored paypal transaction for nicer txn id/date
      db.query('SELECT paypal_order_id, payment_time FROM paypal_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId], (pErr, pRows) => {
        if (!pErr && pRows && pRows[0]) {
          opts.transactionId = pRows[0].paypal_order_id || txn || '';
          if (pRows[0].payment_time) opts.date = new Date(pRows[0].payment_time).toLocaleString();
        }
        // Award points then render
        awardPointsAndThen(function(points) {
          return renderPageWithPoints({ transactionId: opts.transactionId, date: opts.date, paymentMethod: 'PayPal', maskedCard: null, amount: opts.amount, orderId: orderId });
        });
      });
      return;
    }

    // card or other (use last4 if provided)
    opts.transactionId = txn || null;
    opts.maskedCard = last4 ? ('**** ' + String(last4).slice(-4)) : null;
    // Award points then render for non-PayPal methods
    awardPointsAndThen(function(points) {
      return renderPageWithPoints({ transactionId: opts.transactionId, date: opts.date, paymentMethod: method === 'card' ? 'Card' : method, maskedCard: opts.maskedCard, amount: opts.amount, orderId: orderId });
    });
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
  adminDetails: exports.adminDetails,
  applyCoupon: exports.applyCoupon,
  removeCoupon: exports.removeCoupon
};