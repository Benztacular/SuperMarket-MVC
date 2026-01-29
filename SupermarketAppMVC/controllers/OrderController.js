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
          return db.query('DELETE FROM cart_items WHERE user_id = ? AND COALESCE(selected,1) = 1', [userId], () => res.redirect(`/orders/${orderId}/receipt`));
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

          db.query('DELETE FROM cart_items WHERE user_id = ? AND COALESCE(selected,1) = 1', [userId], (dErr) => {
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
    if (!orders.length) return res.json({ orders });

    // attach totalRefunded per order so the frontend can surface partial/full refunds
    const orderIds = orders.map(o => o.id || o.orderId).filter(Boolean);
    if (!orderIds.length) return res.json({ orders });

    db.query('SELECT order_id, COALESCE(SUM(amount),0) AS totalRefunded FROM refunds WHERE order_id IN (?) AND status = ? GROUP BY order_id', [orderIds, 'SUCCESS'], (rErr, rRows = []) => {
      if (rErr) { console.error('orderHistory - refund aggregation error', rErr); return res.json({ orders }); }
      const byId = (rRows || []).reduce((acc, rr) => { acc[rr.order_id] = Number(rr.totalRefunded || 0); return acc; }, {});
      const enriched = orders.map(o => {
        const id = o.id || o.orderId;
        const refunded = Number(byId[id] || 0);
        const totalAmt = Number(o.totalAmount || o.total || o.amount || 0);
        const origStatus = (o.status || '').toString().trim();
        const sLower = origStatus.toLowerCase();

        // Normalize statuses for user-facing list so client-side filters work:
        // - fully refunded => 'Cancelled' (only when refunded amount >= order total)
        // - 'Partially Refunded' => 'Delivered' (per new mapping)
        let normalizedStatus = origStatus;
        if (refunded >= totalAmt && totalAmt > 0) normalizedStatus = 'Cancelled';
        else if (sLower === 'partially refunded') normalizedStatus = 'Delivered';

        return { ...o, totalRefunded: refunded, status: normalizedStatus };
      });
      return res.json({ orders: enriched });
    });
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

  // include total refunded amount per order so the admin UI can show partial/full refunds
  db.query(`SELECT o.id AS orderId, o.user_id AS userId, o.totalAmount, o.status, o.createdAt,
    (SELECT COALESCE(SUM(r.amount),0) FROM refunds r WHERE r.order_id = o.id AND r.status = 'SUCCESS') AS totalRefunded
    FROM orders o ORDER BY o.id DESC`, [], (err, rows) => {
    if (err) { console.error(err); return res.status(500).send('Failed to load orders'); }
    // Normalize historic status values to match current business rules for UI filtering:
    // - Fully refunded (totalRefunded >= totalAmount) => treat as 'Cancelled'
    // - Explicit 'Refunded' status (legacy) => treat as 'Cancelled'
    // - 'Partially Refunded' => treat as 'Delivered' (per new mapping)
    const normalized = (rows || []).map(r => {
      const copy = Object.assign({}, r);
      const totalAmt = Number(copy.totalAmount || 0);
      const refunded = Number(copy.totalRefunded || 0);
      const s = (copy.status || '').toString().trim();
      const sLower = s.toLowerCase();

      if (refunded >= totalAmt && totalAmt > 0) {
        copy.status = 'Cancelled';
      } else if (sLower === 'refunded') {
        copy.status = 'Cancelled';
      } else if (sLower === 'partially refunded') {
        copy.status = 'Delivered';
      }

      return copy;
    });

    return res.render('adminOrders', { orders: normalized });
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
            let cartSql = 'SELECT ci.id AS cart_id, ci.product_id, ci.quantity AS cart_qty, p.quantity AS stock_qty, p.price FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? AND COALESCE(ci.selected, 1) = 1';
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

                // handle applied coupon from session (re-validate server-side)
                let couponDiscount = 0;
                let appliedCoupon = (req.session && req.session.appliedCoupon) ? req.session.appliedCoupon : null;
                
                // Check if the applied coupon is a free delivery voucher
                if (appliedCoupon && appliedCoupon.coupon_id) {
                  conn.query('SELECT is_free_delivery FROM coupons WHERE id = ? LIMIT 1', [appliedCoupon.coupon_id], (fdErr, fdRows = []) => {
                    const isFreeDelivery = (!fdErr && fdRows && fdRows[0] && Number(fdRows[0].is_free_delivery || 0)) === 1;
                    if (isFreeDelivery) {
                      appliedShippingFee = 0; // Free delivery voucher overrides all shipping fees
                    }
                    continueMembershipDiscounts();
                  });
                } else {
                  continueMembershipDiscounts();
                }

                function continueMembershipDiscounts() {
                let discountAmount = 0;
                const discThresh = Number(membership.discount_threshold || 0);
                const discPercent = Number(membership.discount_percent || 0);
                if (discPercent > 0 && itemsTotal >= discThresh) {
                  discountAmount = Number((itemsTotal * (discPercent / 100)).toFixed(2));
                }

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
                              // mark user_coupon as used if applicable (transactional, inline)
                              const couponToMark = (typeof appliedCoupon !== 'undefined' && appliedCoupon && appliedCoupon.coupon_id) ? appliedCoupon : ((req.session && req.session.appliedCoupon) ? req.session.appliedCoupon : null);

                              const markUserCoupon = userCouponIdToMark ? new Promise((resolve) => {
                                conn.query('SELECT uc.times_used, uc.first_used_at, uc.coupon_id, c.max_uses_per_user FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.id = ? FOR UPDATE', [userCouponIdToMark], (selErr, selRows) => {
                                  if (selErr) { console.error('select user_coupon error', selErr); return resolve(); }
                                  const uc = selRows && selRows[0];
                                  const timesUsed = Number(uc?.times_used || 0) + 1;
                                  const maxUses = Number(uc?.max_uses_per_user || 1);
                                  const newStatus = (maxUses && timesUsed >= maxUses) ? 'EXHAUSTED' : 'ACTIVE';
                                  const firstUsed = uc?.first_used_at ? ', first_used_at = first_used_at' : ', first_used_at = NOW()';
                                  conn.query(`UPDATE user_coupons SET times_used = ?, status = ?, last_used_at = NOW()${firstUsed} WHERE id = ?`, [timesUsed, newStatus, userCouponIdToMark], (ucErr) => {
                                    if (ucErr) { console.error('mark user_coupon used error', ucErr); return resolve(); }
                                    if (appliedCoupon && appliedCoupon.coupon_id) {
                                      conn.query('UPDATE coupons SET current_total_uses = current_total_uses + 1 WHERE id = ?', [appliedCoupon.coupon_id], () => resolve());
                                    } else resolve();
                                  });
                                });
                              }) : Promise.resolve();

                              markUserCoupon.then(() => {
                                // additionally mark global coupon as used (create user_coupons row if needed)
                                const markGlobal = (couponToMark && couponToMark.coupon_id && Number(couponToMark.is_global || 0)) ? new Promise((resolve) => {
                                  const ac = couponToMark;
                                  conn.query('INSERT INTO user_coupons (user_id, coupon_id, coupon_code, assigned_at, times_used, first_used_at, last_used_at, status) VALUES (?, ?, ?, NOW(), 1, NOW(), NOW(), "ACTIVE") ON DUPLICATE KEY UPDATE times_used = times_used + 1, last_used_at = NOW()', [userId, ac.coupon_id, (ac.code || '')], (insErr) => {
                                    if (insErr) console.error('mark global coupon used (insert user_coupons) error', insErr);
                                    if (ac && ac.coupon_id) {
                                      conn.query('UPDATE coupons SET current_total_uses = current_total_uses + 1 WHERE id = ?', [ac.coupon_id], (upErr) => {
                                        if (upErr) console.error('order increment coupons.current_total_uses error', upErr);
                                        conn.query('SELECT uc.id, uc.times_used, c.max_uses_per_user FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.user_id = ? AND uc.coupon_id = ? LIMIT 1', [userId, ac.coupon_id], (sErr, sRows = []) => {
                                          if (sErr) console.error('order select user_coupons after insert error', sErr);
                                          const ucRow = sRows && sRows[0];
                                          if (ucRow) {
                                            const times = Number(ucRow.times_used || 0);
                                            const maxU = Number(ucRow.max_uses_per_user || 1);
                                            if (maxU && times >= maxU) {
                                              conn.query('UPDATE user_coupons SET status = ? WHERE id = ?', ['EXHAUSTED', ucRow.id], (stErr) => { if (stErr) console.error('order set EXHAUSTED error', stErr); });
                                            }
                                          }
                                          return resolve();
                                        });
                                      });
                                    } else return resolve();
                                  });
                                }) : Promise.resolve();

                                markGlobal.then(() => {
                                  conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (clearErr) => {
                                    if (clearErr) return rollback('CLEAR_CART_FAIL', clearErr);
                                    conn.commit((commitErr) => {
                                      if (commitErr) return rollback('COMMIT_FAIL', commitErr);
                                      release();
                                      try { if (req.session) req.session.appliedCoupon = null; } catch (e) {}
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
                          conn.query('SELECT uc.times_used, uc.first_used_at, uc.coupon_id, c.max_uses_per_user FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.id = ?', [userCouponIdToMark], (selErr, selRows) => {
                            if (selErr) { console.error('select user_coupon error', selErr); return resolve(); }
                            const uc = selRows && selRows[0];
                            const timesUsed = Number(uc?.times_used || 0) + 1;
                            const maxUses = Number(uc?.max_uses_per_user || 1);
                            const newStatus = (maxUses && timesUsed >= maxUses) ? 'EXHAUSTED' : 'ACTIVE';
                            const firstUsed = uc?.first_used_at ? ', first_used_at = first_used_at' : ', first_used_at = NOW()';
                            conn.query(`UPDATE user_coupons SET times_used = ?, status = ?, last_used_at = NOW()${firstUsed} WHERE id = ?`, [timesUsed, newStatus, userCouponIdToMark], (ucErr) => {
                              if (ucErr) { console.error('mark user_coupon used error', ucErr); return resolve(); }
                              if (appliedCoupon && appliedCoupon.coupon_id) {
                                conn.query('UPDATE coupons SET current_total_uses = current_total_uses + 1 WHERE id = ?', [appliedCoupon.coupon_id], () => resolve());
                              } else resolve();
                            });
                          });
                        }) : Promise.resolve();

                        markUserCoupon.then(() => {
                          // additionally mark global coupon as used (single-use) if applicable
                                const markGlobal = (req.session && req.session.appliedCoupon && req.session.appliedCoupon.coupon_id && Number(req.session.appliedCoupon.is_global || 0)) ? new Promise((resolve) => {
                                  const ac = req.session.appliedCoupon;
                                  conn.query('INSERT INTO user_coupons (user_id, coupon_id, coupon_code, assigned_at, times_used, first_used_at, last_used_at, status) VALUES (?, ?, ?, NOW(), 1, NOW(), NOW(), "ACTIVE") ON DUPLICATE KEY UPDATE times_used = times_used + 1, last_used_at = NOW()', [userId, ac.coupon_id, (ac.code || '')], (insErr) => {
                                    if (insErr) console.error('mark global coupon used (insert user_coupons) error', insErr);
                                    if (ac && ac.coupon_id) {
                                      conn.query('UPDATE coupons SET current_total_uses = current_total_uses + 1 WHERE id = ?', [ac.coupon_id], (upErr) => {
                                        if (upErr) console.error('order increment coupons.current_total_uses error', upErr);
                                        conn.query('SELECT uc.id, uc.times_used, c.max_uses_per_user FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.user_id = ? AND uc.coupon_id = ? LIMIT 1', [userId, ac.coupon_id], (sErr, sRows = []) => {
                                          if (sErr) console.error('order select user_coupons after insert error', sErr);
                                          const ucRow = sRows && sRows[0];
                                          if (ucRow) {
                                            const times = Number(ucRow.times_used || 0);
                                            const maxU = Number(ucRow.max_uses_per_user || 1);
                                            if (maxU && times >= maxU) {
                                              conn.query('UPDATE user_coupons SET status = ? WHERE id = ?', ['EXHAUSTED', ucRow.id], (stErr) => { if (stErr) console.error('order set EXHAUSTED error', stErr); });
                                            }
                                          }
                                          return resolve();
                                        });
                                      });
                                    } else return resolve();
                                  });
                                }) : Promise.resolve();

                          markGlobal.then(() => {
                            conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (clearErr) => {
                              if (clearErr) return rollback('CLEAR_CART_FAIL', clearErr);
                              conn.commit((commitErr) => {
                                if (commitErr) return rollback('COMMIT_FAIL', commitErr);
                                release();
                                try { if (req.session) req.session.appliedCoupon = null; } catch (e) {}
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
                } // end continueMembershipDiscounts

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
                      // Accept coupons that are ASSIGNED or already ACTIVE (legacy/status differences)
                      conn.query('SELECT * FROM user_coupons WHERE id = ? AND user_id = ? AND status IN ("ASSIGNED","ACTIVE") LIMIT 1', [userCouponId, userId], (uc2Err, uc2Rows = []) => {
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
        db.query('SELECT * FROM user_coupons WHERE user_id = ? AND coupon_id = ? AND coupon_code = ? AND status IN ("ASSIGNED", "ACTIVE") LIMIT 1', [userId, coupon.id, coupon.coupon_code], (ucErr, ucRows = []) => {
          if (ucErr) { console.error('applyCoupon - user_coupons query error', ucErr); return res.status(500).json({ success: false, message: 'Internal error' }); }
          if (!ucRows || !ucRows.length) return res.json({ success: false, message: 'Coupon not assigned to this user' });
          const userCoupon = ucRows[0];
          // check if user has reached max usage limit
          const timesUsed = Number(userCoupon.times_used || 0);
          const maxUses = Number(coupon.max_uses_per_user || 1);
          if (timesUsed >= maxUses) return res.json({ success: false, message: 'Coupon usage limit reached' });
          return continueWithCartTotal(coupon.min_spend || 0, userCoupon.id, coupon, maxUses);
        });
      } else {
        // For global coupons, check usage limits
        db.query('SELECT * FROM user_coupons WHERE user_id = ? AND coupon_id = ? LIMIT 1', [userId, coupon.id], (usedErr, usedRows = []) => {
          if (usedErr) { console.error('applyCoupon - user usage lookup error', usedErr); return res.status(500).json({ success: false, message: 'Internal error' }); }
          const userCoupon = usedRows && usedRows[0];
          const timesUsed = Number(userCoupon?.times_used || 0);
          const maxUses = Number(coupon.max_uses_per_user || 1);
          if (timesUsed >= maxUses) return res.json({ success: false, message: 'Coupon usage limit reached' });
          // check total usage limit if set
          if (coupon.total_usage_limit && Number(coupon.current_total_uses || 0) >= Number(coupon.total_usage_limit)) {
            return res.json({ success: false, message: 'Coupon usage limit reached' });
          }
          return continueWithCartTotal(coupon.min_spend || 0, userCoupon?.id || null, coupon, maxUses);
        });
      }

      function continueWithCartTotal(requiredMinSpend, userCouponId, coupon, maxUses) {
        // compute cart subtotal (respect selectedCartItemIds in session)
        let cartSql = 'SELECT ci.quantity AS qty, p.price FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? AND COALESCE(ci.selected, 1) = 1';
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
          // If coupon is a free-delivery voucher, discount should equal
          // the shipping fee (selected method price or a fallback active method),
          // instead of applying to item subtotal.
          if (Number(coupon.is_free_delivery || 0) === 1) {
            return db.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC', [], (smErr, smRows = []) => {
              if (smErr) { console.error('applyCoupon - shipping_methods lookup error', smErr); return res.status(500).json({ success: false, message: 'Internal error' }); }
              const selId = req.session && req.session.selectedShippingMethodId ? Number(req.session.selectedShippingMethodId) : null;
              let found = null;
              if (selId) found = (smRows || []).find(r => Number(r.id) === Number(selId));
              if (!found) found = (smRows && smRows.length) ? smRows[0] : null;
              const shippingPrice = found ? Number(found.price || 0) : 0;
              discount = Number(shippingPrice.toFixed(2));
              // store applied coupon in session so final order placement can access it
              try { if (req.session) req.session.appliedCoupon = { coupon_id: coupon.id, user_coupon_id: userCouponId, code: coupon.coupon_code, discount: discount, is_global: Number(coupon.is_global || 0), is_active: (typeof coupon.is_active !== 'undefined') ? Number(coupon.is_active || 0) : 1, max_uses_per_user: maxUses, min_spend: Number(requiredMinSpend || 0) }; } catch (e) { /* ignore session write errors */ }
              const newTotal = Number((itemsTotal - discount).toFixed(2));
              return res.json({ success: true, discount: discount, subtotal: Number(itemsTotal.toFixed(2)), newTotal: newTotal, coupon: { id: coupon.id, code: coupon.coupon_code, type: coupon.discount_type, value: Number(coupon.discount_value) }, userCouponId: userCouponId });
            });
          }
          // non-free-delivery coupons: calculate based on items total
          if (coupon.discount_type === 'PERCENTAGE') {
            discount = Number((itemsTotal * (Number(coupon.discount_value || 0) / 100)).toFixed(2));
          } else {
            discount = Number(coupon.discount_value || 0);
          }
          if (discount > itemsTotal) discount = itemsTotal;

          const newTotal = Number((itemsTotal - discount).toFixed(2));
          // store applied coupon in session so final order placement can access it
          try { if (req.session) req.session.appliedCoupon = { coupon_id: coupon.id, user_coupon_id: userCouponId, code: coupon.coupon_code, discount: discount, is_global: Number(coupon.is_global || 0), is_active: (typeof coupon.is_active !== 'undefined') ? Number(coupon.is_active || 0) : 1, max_uses_per_user: maxUses, min_spend: Number(requiredMinSpend || 0) }; } catch (e) { /* ignore session write errors */ }
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
  // Reuse the more feature-complete orderHistoryPage implementation so
  // both `/orders` and `/orderHistory` routes include refund data.
  return orderHistoryPage(req, res);
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
      SELECT oi.order_id, oi.id, oi.product_id, oi.quantity AS qty, oi.price, p.productName, p.image
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (?)
    `;
    db.query(itemsSql, [orderIds], (iErr, itemRows = []) => {
      if (iErr) { console.error(iErr); }
      const itemsByOrder = (itemRows || []).reduce((acc, r) => {
        const id = r.order_id;
        acc[id] = acc[id] || [];
        acc[id].push({ 
          id: r.id,
          productId: r.product_id,
          name: r.productName || r.product_name || '', 
          qty: r.qty || r.quantity || 0, 
          price: Number(r.price || 0), 
          image: r.image || r.product_image || '' 
        });
        return acc;
      }, {});

      // Load refund status for each order
      const refundSql = `
        SELECT order_id, id, status, amount, requested_amount, createdAt, admin_note, reason
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

        // Parse selected items from successful refunds and build a map of refunded item ids -> refundedQty per order
        // Support both formats: [{id,qty}, ...] and [id, id, ...] and allow matching by order_item id or product_id.
        const refundedItemsByOrder = {};
        (refundRows || []).filter(r => r.status === 'SUCCESS').forEach(refund => {
          const orderId = refund.order_id;
          if (!refundedItemsByOrder[orderId]) refundedItemsByOrder[orderId] = new Map();

          const reasonStr = refund.reason || '';
          const itemsMatch = reasonStr.match(/\| items: (\[.*?\])$/);
          if (itemsMatch) {
            try {
              const selectedItems = JSON.parse(itemsMatch[1]);
              if (Array.isArray(selectedItems)) {
                selectedItems.forEach(si => {
                  // si may be a number (id) or an object { id, qty }
                  const idVal = Number((si && typeof si === 'object') ? (si.id ?? si.productId ?? si.product_id) : si);
                  if (isNaN(idVal)) return;
                  const qtyVal = (si && typeof si === 'object') ? (Number(si.qty) || Number(si.qty || si.quantity) || null) : null;
                  // accumulate if multiple refunds
                  const existing = refundedItemsByOrder[orderId].get(idVal);
                  if (existing == null) {
                    refundedItemsByOrder[orderId].set(idVal, qtyVal);
                  } else {
                    // if either is null, keep null (unknown/full). otherwise sum quantities
                    if (existing === null || qtyVal === null) {
                      refundedItemsByOrder[orderId].set(idVal, null);
                    } else {
                      refundedItemsByOrder[orderId].set(idVal, existing + qtyVal);
                    }
                  }
                });
              }
            } catch (e) {
              console.error('Failed to parse refund items JSON:', e);
            }
          }
        });

        // Also aggregate total refunded amounts per order (successful refunds)
        db.query('SELECT order_id, COALESCE(SUM(amount),0) AS totalRefunded FROM refunds WHERE order_id IN (?) AND status = ? GROUP BY order_id', [orderIds, 'SUCCESS'], (aggErr, aggRows = []) => {
          if (aggErr) { console.error('Error loading refund aggregates:', aggErr); }
          const refundedByOrder = (aggRows || []).reduce((acc, r) => { acc[r.order_id] = Number(r.totalRefunded || 0); return acc; }, {});

          orders.forEach(o => {
            const totalAmt = Number(o.totalAmount || o.total || o.amount || 0);
            const refunded = Number(refundedByOrder[o.id] || 0);
            o.items = itemsByOrder[o.id] || [];
            o.refund = refundsByOrder[o.id] || null;
            o.totalRefunded = refunded;

            // Mark items as refunded only when refunded qty covers the item quantity.
            // Support matching by order_items.id or by product_id (in case reason used product ids).
            const refundedMap = refundedItemsByOrder[o.id] || new Map();
            o.items.forEach(item => {
              const orderItemId = Number(item.id);
              const productId = Number(item.productId || item.product_id || 0);
              let refundedQty = null;

              if (refundedMap.has(orderItemId)) refundedQty = refundedMap.get(orderItemId);
              else if (productId && refundedMap.has(productId)) refundedQty = refundedMap.get(productId);

              if (refundedQty === null && (refundedMap.has(orderItemId) || refundedMap.has(productId))) {
                // null indicates unknown/unspecified qty => mark as refunded
                item.isRefunded = true;
              } else if (typeof refundedQty === 'number') {
                item.isRefunded = refundedQty >= Number(item.qty || 0);
              } else {
                item.isRefunded = false;
              }
            });

            // Build refundedDetails array for view (name, image, refundedQty, unitPrice, total)
            o.refundedDetails = [];
            if (refundedMap && typeof refundedMap.forEach === 'function') {
              refundedMap.forEach((qtyVal, idKey) => {
                const idNum = Number(idKey);
                const matched = o.items.find(it => Number(it.id) === idNum || Number(it.productId || it.product_id || 0) === idNum);
                const qtyToShow = qtyVal === null ? (matched ? Number(matched.qty || 0) : null) : Number(qtyVal || 0);
                if (matched) {
                  const unitPrice = Number(matched.price || 0);
                  // Attach refundedQty to the matched order item for view consumption
                  const assignedQty = (qtyToShow === null) ? Number(matched.qty || 0) : Number(qtyToShow || 0);
                  matched.refundedQty = assignedQty;
                  const originalQty = Number(matched.qty || 0);
                  const remainingQty = Math.max(0, originalQty - assignedQty);
                  const lineOriginalTotal = Number((unitPrice * originalQty).toFixed(2));
                  const lineRemainingTotal = Number((unitPrice * remainingQty).toFixed(2));
                  const refundedAmountLine = Number((lineOriginalTotal - lineRemainingTotal).toFixed(2));
                  o.refundedDetails.push({
                    id: idNum,
                    name: matched.name || matched.productName || 'Item',
                    image: matched.image || 'default.png',
                    refundedQty: assignedQty,
                    originalQty,
                    remainingQty,
                    unitPrice,
                    lineOriginalTotal,
                    lineRemainingTotal,
                    refundedAmountLine
                  });
                } else {
                  o.refundedDetails.push({ id: idNum, name: 'Unknown item', image: 'default.png', qty: qtyToShow, unitPrice: 0, total: 0 });
                }
              });
            }

            // Normalize statuses to support UI filters and the requested business rules
            const s = (o.status || '').toString().trim();
            const sLower = s.toLowerCase();
            // Only mark Cancelled when the total refunded amount covers the order total
            if (refunded >= totalAmt && totalAmt > 0) {
              o.status = 'Cancelled';
            } else if (sLower === 'partially refunded') {
              o.status = 'Delivered';
            }
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
    // Normalize: if any refund row exists for an order, treat it as Cancelled for listing
    const orderIds = (rows || []).map(r => r.orderId).filter(Boolean);
    if (!orderIds.length) return res.render('adminOrders', { orders: rows || [] });

    db.query('SELECT order_id, COALESCE(SUM(amount),0) AS totalRefunded, COUNT(*) AS refundCount FROM refunds WHERE order_id IN (?) GROUP BY order_id', [orderIds], (rfErr, rfRows = []) => {
      if (rfErr) { console.error('adminList - refund aggregation error', rfErr); return res.render('adminOrders', { orders: rows || [] }); }
      const refundsById = (rfRows || []).reduce((acc, rr) => { acc[rr.order_id] = rr; return acc; }, {});
      const normalized = (rows || []).map(r => {
        const copy = Object.assign({}, r);
        const agg = refundsById[copy.orderId] || null;
        const refunded = agg ? Number(agg.totalRefunded || 0) : 0;
        const refundCount = agg ? Number(agg.refundCount || 0) : 0;
        const totalAmt = Number(copy.totalAmount || 0);

        if (refunded >= totalAmt && totalAmt > 0) {
          copy.status = 'Cancelled';
        } else if ((copy.status || '').toString().toLowerCase() === 'partially refunded') {
          copy.status = 'Delivered';
        }
        return copy;
      });

      return res.render('adminOrders', { orders: normalized });
    });
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
    const order = orderRows[0];
    db.query(itemsSql, [req.params.id], (itemErr, itemRows) => {
      if (itemErr) return next(itemErr);
      const items = itemRows || [];
      // compute subtotal from items (fallback if order.subtotal missing)
      const itemsSubtotal = items.reduce((acc, it) => acc + (Number(it.price || 0) * Number(it.quantity || 0)), 0);

      // prepare values from order
      const shippingFee = Number(order.shipping_fee || 0);
      const couponDiscount = Number(order.coupon_discount || 0);
      const couponCode = order.coupon_code_snapshot || null;

      // load delivery address and shipping method (parallel)
      const addrPromise = new Promise((resolve) => {
        if (!order.delivery_address_id) return resolve(null);
        db.query('SELECT * FROM delivery_addresses WHERE id = ? LIMIT 1', [order.delivery_address_id], (aErr, aRows = []) => {
          if (aErr) { console.error('adminDetails - load delivery address error', aErr); return resolve(null); }
          resolve(aRows[0] || null);
        });
      });

      const shipPromise = new Promise((resolve) => {
        if (!order.shipping_method_id) return resolve(null);
        db.query('SELECT * FROM shipping_methods WHERE id = ? LIMIT 1', [order.shipping_method_id], (sErr, sRows = []) => {
          if (sErr) { console.error('adminDetails - load shipping method error', sErr); return resolve(null); }
          resolve(sRows[0] || null);
        });
      });

      // detect payment info (paypal/stripe/nets) for nicer display
      const txnPromise = new Promise((resolve) => {
        db.query('SELECT paypal_order_id, payment_time FROM paypal_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id], (pErr, pRows = []) => {
          if (!pErr && pRows && pRows[0]) return resolve({ method: 'PayPal', id: pRows[0].paypal_order_id, date: pRows[0].payment_time });
          db.query('SELECT stripe_txn_id, stripe_charge_id, payment_time FROM stripe_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id], (sErr, sRows = []) => {
            if (!sErr && sRows && sRows[0]) return resolve({ method: 'Card', id: sRows[0].stripe_txn_id || sRows[0].stripe_charge_id, date: sRows[0].payment_time });
            db.query('SELECT nets_txn_id, merchant_txn_ref, payment_time FROM nets_transactions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id], (nErr, nRows = []) => {
              if (!nErr && nRows && nRows[0]) return resolve({ method: 'NETS', id: nRows[0].nets_txn_id || nRows[0].merchant_txn_ref, date: nRows[0].payment_time });
              return resolve({ method: order.payment_method || 'Card', id: order.transaction_id || null });
            });
          });
        });
      });

      Promise.all([addrPromise, shipPromise, txnPromise]).then(([deliveryAddress, shippingMethod, txnInfo]) => {
        // Load refund data to determine which items were refunded
        db.query('SELECT * FROM refunds WHERE order_id = ? AND status = ? ORDER BY id DESC LIMIT 1', [order.id, 'SUCCESS'], (refErr, refRows = []) => {
          let refundedItemIds = new Set();
          if (!refErr && refRows && refRows[0]) {
            try {
              const match = (refRows[0].reason || '').match(/\| items: (\[.*?\])/);
              if (match && match[1]) {
                const selectedItems = JSON.parse(match[1]);
                selectedItems.forEach(si => refundedItemIds.add(Number(si.id)));
              }
            } catch (e) {
              console.error('adminDetails - failed to parse refund items', e);
            }
          }
          
          // Mark items as refunded
          items.forEach(item => {
            item.isRefunded = refundedItemIds.has(Number(item.id));
          });

        // compute membership discount based on stored subtotal or itemsSubtotal
        const subtotalForDiscount = Number(order.subtotal || itemsSubtotal || 0);
        Membership.getUserMembership(order.user_id, (mErr, membership) => {
          if (mErr) console.error('adminDetails - membership lookup failed', mErr);
          if (!membership) membership = { plan_name: 'Free', discount_percent: 0, discount_threshold: 0 };
          const discPercent = Number(membership.discount_percent || 0);
          const discThresh = Number(membership.discount_threshold || 0);
          let membershipDiscount = 0;
          if (discPercent > 0 && subtotalForDiscount >= discThresh) {
            membershipDiscount = Number((subtotalForDiscount * (discPercent / 100)).toFixed(2));
          }

          // calculate final total as subtotal + shipping - membership - coupon
          const subtotal = Number(order.subtotal != null ? order.subtotal : itemsSubtotal);
          const calculatedTotal = Number(subtotal || 0) + Number(shippingFee || 0) - Number(membershipDiscount || 0) - Number(couponDiscount || 0);

          return res.render('adminOrderDetails', {
            order: order,
            items: items,
            subtotal: subtotal,
            itemsSubtotal: itemsSubtotal,
            shippingFee: shippingFee,
            shippingMethod: shippingMethod || null,
            deliveryAddress: deliveryAddress || null,
            membershipDiscount: membershipDiscount,
            membershipName: membership.plan_name || 'Free',
            couponDiscount: couponDiscount,
            couponCode: couponCode,
            calculatedTotal: calculatedTotal,
            paymentMethod: txnInfo && txnInfo.method,
            transactionId: txnInfo && txnInfo.id
          });
        });
        });
      }).catch((e) => {
        console.error('adminDetails - parallel load error', e);
        // fallback render with best-effort values
        const subtotal = Number(order.subtotal != null ? order.subtotal : itemsSubtotal);
        const calculatedTotal = Number(subtotal || 0) + Number(shippingFee || 0) - Number(0) - Number(couponDiscount || 0);
        return res.render('adminOrderDetails', { order: order, items: items, subtotal: subtotal, itemsSubtotal: itemsSubtotal, shippingFee: shippingFee, membershipDiscount: 0, couponDiscount: couponDiscount, calculatedTotal: calculatedTotal, paymentMethod: order.payment_method || 'Card', transactionId: order.transaction_id || null, deliveryAddress: null, shippingMethod: null });
      });
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
      amount: opts.amount || null,  // ONLY use database amount, ignore query string
      subtotal: opts.subtotal || null,
      membershipDiscount: opts.membershipDiscount || 0,
      shippingFee: opts.shippingFee || null,
      couponDiscount: opts.couponDiscount || 0,
      couponCode: opts.couponCode || null,
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
        amount: merged.amount || null,  // ONLY use database amount, ignore query string
        subtotal: merged.subtotal || null,
        membershipDiscount: merged.membershipDiscount || 0,
        shippingFee: merged.shippingFee || null,
        couponDiscount: merged.couponDiscount || 0,
        couponCode: merged.couponCode || null,
        orderId: merged.orderId || orderId || null,
        pointsEarned: merged.pointsEarned || 0
      });
    });
  };

  if (!orderId) return renderPage();

  // load order to confirm ownership and get createdAt / total / coupon details
  db.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId], (err, rows) => {
    if (err) { console.error('paymentSuccess - db error', err); return res.status(500).send('Failed to load order'); }
    const order = rows && rows[0];
    if (!order) return res.status(404).send('Order not found');

    if (Number(order.user_id) !== Number(userId) && !(sessionUser.role === 'admin')) {
      return res.status(403).send('Forbidden');
    }

    const opts = {};
    opts.amount = opts.amount || order.totalAmount;
    opts.subtotal = order.subtotal || 0;
    opts.shippingFee = order.shipping_fee || 0;
    opts.couponDiscount = order.coupon_discount || 0;
    opts.couponCode = order.coupon_code_snapshot || null;
    opts.date = new Date(order.createdAt || order.orderDate || Date.now()).toLocaleString();

    // compute membership discount: use stored subtotal when available, otherwise sum order_items
    function computeMembershipDiscount(cb) {
      const subtotalFromOrder = Number(order.subtotal || 0);
      const proceed = (itemsSubtotal) => {
        Membership.getUserMembership(sessionUser?.id || req.session?.userId, (mErr, membership) => {
          if (mErr) console.error('membership lookup for paymentSuccess failed', mErr);
          if (!membership) membership = { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 };
          const discPercent = Number(membership.discount_percent || 0);
          const discThresh = Number(membership.discount_threshold || 0);
          let discountAmount = 0;
          if (discPercent > 0 && itemsSubtotal >= discThresh) discountAmount = Number((itemsSubtotal * (discPercent / 100)).toFixed(2));
          return cb(null, discountAmount, membership);
        });
      };

      if (subtotalFromOrder > 0) return proceed(subtotalFromOrder);
      // fallback: sum order_items
      db.query('SELECT SUM(price * quantity) AS subtotal FROM order_items WHERE order_id = ?', [orderId], (sErr, sRows = []) => {
        if (sErr) { console.error('failed to compute order items subtotal', sErr); return proceed(0); }
        const sum = Number(sRows && sRows[0] && sRows[0].subtotal) || 0;
        return proceed(sum);
      });
    }

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
        // compute membership discount, then award points and render
        computeMembershipDiscount((mErr, membershipDiscount) => {
          opts.membershipDiscount = membershipDiscount || 0;
          awardPointsAndThen(function(points) {
            return renderPageWithPoints({ transactionId: opts.transactionId, date: opts.date, paymentMethod: 'PayPal', maskedCard: null, amount: opts.amount, subtotal: opts.subtotal, membershipDiscount: opts.membershipDiscount, shippingFee: opts.shippingFee, couponDiscount: opts.couponDiscount, couponCode: opts.couponCode, orderId: orderId });
          });
        });
      });
      return;
    }

    // card or other (use last4 if provided)
    opts.transactionId = txn || null;
    opts.maskedCard = last4 ? ('**** ' + String(last4).slice(-4)) : null;
    // compute membership discount, then award points and render for non-PayPal methods
    computeMembershipDiscount((mErr, membershipDiscount) => {
      opts.membershipDiscount = membershipDiscount || 0;
      awardPointsAndThen(function(points) {
        return renderPageWithPoints({ transactionId: opts.transactionId, date: opts.date, paymentMethod: method === 'card' ? 'Card' : method, maskedCard: opts.maskedCard, amount: opts.amount, subtotal: opts.subtotal, membershipDiscount: opts.membershipDiscount, shippingFee: opts.shippingFee, couponDiscount: opts.couponDiscount, couponCode: opts.couponCode, orderId: orderId });
      });
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