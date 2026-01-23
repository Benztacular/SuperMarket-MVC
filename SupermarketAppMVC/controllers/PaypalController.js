const paypalService = require('../services/paypal');
const db = require('../db');
const Membership = require('../models/Membership');
const PaypalTransaction = require('../models/PaypalTransaction');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

async function createOrder(req, res, next) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // compute total from cart_items
    const cartSql = `
      SELECT ci.quantity AS quantity, p.price AS price
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ?
    `;

    db.query(cartSql, [userId], async (err, rows) => {
      if (err) return next(err);
      const items = rows || [];
      if (!items.length) return res.status(400).json({ error: 'Cart empty' });

      // include shipping fee based on selected shipping method
      const selectedShippingMethodId = req.session?.selectedShippingMethodId || null;
      const pickShipping = () => new Promise((resolve, reject) => {
        if (!selectedShippingMethodId) {
          return db.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (sErr, sRows = []) => {
            if (sErr) return reject(sErr);
            if (!sRows.length) return reject(new Error('NO_SHIP_METHOD'));
            return resolve(sRows[0]);
          });
        }
        db.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 AND id = ? LIMIT 1', [selectedShippingMethodId], (sErr, sRows = []) => {
          if (sErr) return reject(sErr);
          if (sRows.length) return resolve(sRows[0]);
          db.query('SELECT id, price FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', [], (fErr, fRows = []) => {
            if (fErr) return reject(fErr);
            if (!fRows.length) return reject(new Error('NO_SHIP_METHOD'));
            return resolve(fRows[0]);
          });
        });
      });

      let shippingFee = 0;
      try {
        const ship = await pickShipping();
        shippingFee = Number(ship.price || 0);
        if (!req.session.selectedShippingMethodId && ship.id) {
          req.session.selectedShippingMethodId = ship.id;
        }
      } catch (shipErr) {
        console.error('createOrder shipping error', shipErr);
        return res.status(400).json({ error: 'No shipping method available' });
      }

      const itemsTotal = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 0), 0);
      const total = itemsTotal + shippingFee;
      if (total <= 0) return res.status(400).json({ error: 'Invalid total' });

      const order = await paypalService.createOrder(total);
      return res.json({ orderID: order.id, amount: total });
    });
  } catch (ex) {
    next(ex);
  }
}

async function captureOrder(req, res, next) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'Missing orderID' });

    const capture = await paypalService.captureOrder(orderID);

    // attempt to extract capture info
    const captureUnit = (capture.purchase_units && capture.purchase_units[0]) || {};
    const payments = (captureUnit.payments && captureUnit.payments.captures && captureUnit.payments.captures[0]) || {};
    const status = payments.status || capture.status || null;

    if (!status || !/COMPLET|COMPLETED/i.test(String(status))) {
      return res.status(400).json({ error: 'Payment not completed', detail: capture });
    }

    // Create local order and records in a transaction
    const conn = db;
    conn.beginTransaction((txErr) => {
      if (txErr) return next(txErr);

      const cartSql = `
        SELECT ci.id AS cart_id, ci.product_id, ci.quantity,
               p.price AS unit_price, p.quantity AS stock, p.productName
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
        WHERE ci.user_id = ?
        FOR UPDATE
      `;
      conn.query(cartSql, [userId], (cErr, cartRows) => {
        if (cErr) return conn.rollback(() => next(cErr));
        if (!cartRows || cartRows.length === 0) return conn.rollback(() => res.status(400).json({ error: 'Cart empty' }));

        for (const r of cartRows) {
          if (Number(r.quantity) > Number(r.stock)) return conn.rollback(() => res.status(400).json({ error: `Insufficient stock for ${r.productName}` }));
        }

        // resolve delivery address from session/default
        const selectedAddressId = req.session?.selectedAddressId || null;
        const addressSql = 'SELECT id FROM delivery_addresses WHERE user_id = ? ORDER BY (id = ?) DESC, is_default DESC, id ASC LIMIT 1';
        conn.query(addressSql, [userId, selectedAddressId || 0], (addrErr, addrRows = []) => {
          if (addrErr) return conn.rollback(() => next(addrErr));
          if (!addrRows.length) return conn.rollback(() => res.status(400).json({ error: 'Please add a delivery address' }));
          const deliveryAddressId = addrRows[0].id;

          // resolve shipping method from session or fallback
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
            if (!req.session.selectedShippingMethodId) req.session.selectedShippingMethodId = shippingMethodId;

            const itemsTotal = cartRows.reduce((s, r) => s + Number(r.unit_price || 0) * Number(r.quantity || 0), 0);

            // apply membership perks (free shipping / priority discount / percent discount)
            Membership.getUserMembership(userId, (mErr, membership) => {
              if (mErr) console.error('paypal.capture - membership fetch error', mErr);
              if (!membership) membership = { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 };

              let appliedShippingFee = Number(shippingFee || 0);
              const methodName = String(shipRow?.method_name || '').toLowerCase();
              const isStandard = methodName.includes('standard');
              const isPriority = methodName.includes('priority');

              if (isStandard && (membership.free_standard_delivery || (itemsTotal >= Number(membership.free_delivery_threshold || 0)))) {
                appliedShippingFee = 0;
              }
              if (isPriority && Number(membership.priority_delivery_discount || 0) > 0) {
                appliedShippingFee = Math.max(0, Number(shippingFee || 0) - Number(membership.priority_delivery_discount || 0));
              }

              let discountAmount = 0;
              const discThresh = Number(membership.discount_threshold || 0);
              const discPercent = Number(membership.discount_percent || 0);
              if (discPercent > 0 && itemsTotal >= discThresh) {
                discountAmount = Number((itemsTotal * (discPercent / 100)).toFixed(2));
              }

              const totalWithShipping = Number((itemsTotal + appliedShippingFee - discountAmount).toFixed(2));

              // check for applied coupon in session
              const appliedCoupon = req.session && req.session.appliedCoupon ? req.session.appliedCoupon : null;
              const couponIdToStore = appliedCoupon && appliedCoupon.coupon_id ? appliedCoupon.coupon_id : null;
              const couponCodeSnapshot = appliedCoupon && appliedCoupon.code ? appliedCoupon.code : null;
              const couponDiscount = Number((appliedCoupon && Number(appliedCoupon.discount || 0)) || 0);

              conn.query(
                'INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, coupon_id, coupon_code_snapshot, coupon_discount, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW())',
                [userId, deliveryAddressId, shippingMethodId, appliedShippingFee, couponIdToStore, couponCodeSnapshot, couponDiscount, totalWithShipping, 'Paid'],
                (oErr, oRes) => {
                  if (oErr) {
                    if (oErr && oErr.code === 'ER_BAD_FIELD_ERROR') {
                      console.warn('PayPal capture: orders table missing coupon columns, retrying without coupon fields');
                      return conn.query('INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, NOW(), ?, ?, NOW())', [userId, deliveryAddressId, shippingMethodId, appliedShippingFee, totalWithShipping, 'Paid'], (o2Err, o2Res) => {
                        if (o2Err) return conn.rollback(() => next(o2Err));
                        const orderId = o2Res.insertId;

                        const vals = cartRows.map(r => [orderId, r.product_id, r.quantity, Number(r.unit_price || 0)]);
                        const placeholders = vals.map(() => '(?, ?, ?, ?)').join(',');
                        const flat = vals.flat();
                        conn.query(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ${placeholders}`, flat, (oiErr) => {
                          if (oiErr) return conn.rollback(() => next(oiErr));
                          // continue below as original
                          continuePaypalAfterItems(orderId);
                        });
                      });
                    }
                    return conn.rollback(() => next(oErr));
                  }
                  const orderId = oRes.insertId;

                  const vals = cartRows.map(r => [orderId, r.product_id, r.quantity, Number(r.unit_price || 0)]);
                  const placeholders = vals.map(() => '(?, ?, ?, ?)').join(',');
                  const flat = vals.flat();
                  conn.query(`INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ${placeholders}`, flat, (oiErr) => {
                    if (oiErr) return conn.rollback(() => next(oiErr));
                    continuePaypalAfterItems(orderId);
                  });

                  function continuePaypalAfterItems(orderId) {
                    const updates = cartRows.map(r => new Promise((resolve, reject) => {
                      conn.query('UPDATE products SET quantity = quantity - ? WHERE id = ?', [Number(r.quantity), r.product_id], (uErr) => uErr ? reject(uErr) : resolve());
                    }));

                    Promise.all(updates)
                      .then(() => {
                        conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (dErr) => {
                          if (dErr) return conn.rollback(() => next(dErr));

                          // persist paypal transaction
                          const payerEmail = (capture.payer && capture.payer.email_address) || null;
                          const amount = (payments.amount && payments.amount.value) || String(totalWithShipping || (itemsTotal + shippingFee));
                          const currency = (payments.amount && payments.amount.currency_code) || (process.env.PAYPAL_CURRENCY || 'SGD');
                          const paymentStatus = payments.status || capture.status || 'COMPLETED';
                          const paymentTime = (payments && payments.update_time) ? new Date(payments.update_time) : new Date();
                          const captureId = (payments && payments.id) || null;

                          conn.query('INSERT INTO paypal_transactions (user_id, order_id, paypal_order_id, paypal_capture_id, payer_email, amount, currency, payment_status, payment_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                            [userId, orderId, orderID, captureId, payerEmail, amount, currency, paymentStatus, paymentTime], (ptErr) => {
                              if (ptErr) return conn.rollback(() => next(ptErr));

                              // mark user coupon used if applicable
                                  if (appliedCoupon && appliedCoupon.user_coupon_id) {
                                    conn.query('UPDATE user_coupons SET status = "USED", used_at = NOW() WHERE id = ? AND status = "ASSIGNED"', [appliedCoupon.user_coupon_id], (ucErr) => {
                                      if (ucErr) console.error('mark user_coupon used error', ucErr);
                                      // also record per-user usage for global coupons instead of deactivating the coupon
                                      if (appliedCoupon && appliedCoupon.coupon_id && Number(appliedCoupon.is_global || 0)) {
                                        conn.query('INSERT INTO user_coupons (user_id, coupon_id, coupon_code, assigned_at, used_at, status, min_spend) VALUES (?, ?, ?, NOW(), NOW(), "USED", ?) ', [userId, appliedCoupon.coupon_id, (appliedCoupon.code || ''), Number(appliedCoupon.min_spend || 0)], (insErr) => {
                                          if (insErr) console.error('mark global coupon used (insert user_coupons) error', insErr);
                                          conn.commit((cmErr) => {
                                            if (cmErr) return conn.rollback(() => next(cmErr));
                                            const txnId = (payments && payments.id) ? payments.id : orderID;
                                            const encodedTxn = encodeURIComponent(txnId || '');
                                            const encodedAmount = encodeURIComponent(amount || totalWithShipping || (itemsTotal + shippingFee) || '');
                                            return res.json({ success: true, redirect: `/payment/success?orderId=${orderId}&method=paypal&txn=${encodedTxn}&amount=${encodedAmount}` });
                                          });
                                        });
                                      } else {
                                        conn.commit((cmErr) => {
                                          if (cmErr) return conn.rollback(() => next(cmErr));
                                          const txnId = (payments && payments.id) ? payments.id : orderID;
                                          const encodedTxn = encodeURIComponent(txnId || '');
                                          const encodedAmount = encodeURIComponent(amount || totalWithShipping || (itemsTotal + shippingFee) || '');
                                          return res.json({ success: true, redirect: `/payment/success?orderId=${orderId}&method=paypal&txn=${encodedTxn}&amount=${encodedAmount}` });
                                        });
                                      }
                                    });
                                  } else {
                                    // no user_coupon; for global coupon record per-user usage
                                    if (appliedCoupon && appliedCoupon.coupon_id && Number(appliedCoupon.is_global || 0)) {
                                      conn.query('INSERT INTO user_coupons (user_id, coupon_id, coupon_code, assigned_at, used_at, status, min_spend) VALUES (?, ?, ?, NOW(), NOW(), "USED", ?)', [userId, appliedCoupon.coupon_id, (appliedCoupon.code || ''), Number(appliedCoupon.min_spend || 0)], (insErr) => {
                                        if (insErr) console.error('mark global coupon used (insert user_coupons) error', insErr);
                                        conn.commit((cmErr) => {
                                          if (cmErr) return conn.rollback(() => next(cmErr));
                                          const txnId = (payments && payments.id) ? payments.id : orderID;
                                          const encodedTxn = encodeURIComponent(txnId || '');
                                          const encodedAmount = encodeURIComponent(amount || totalWithShipping || (itemsTotal + shippingFee) || '');
                                          return res.json({ success: true, redirect: `/payment/success?orderId=${orderId}&method=paypal&txn=${encodedTxn}&amount=${encodedAmount}` });
                                        });
                                      });
                                    } else {
                                      conn.commit((cmErr) => {
                                        if (cmErr) return conn.rollback(() => next(cmErr));
                                        const txnId = (payments && payments.id) ? payments.id : orderID;
                                        const encodedTxn = encodeURIComponent(txnId || '');
                                        const encodedAmount = encodeURIComponent(amount || totalWithShipping || (itemsTotal + shippingFee) || '');
                                        return res.json({ success: true, redirect: `/payment/success?orderId=${orderId}&method=paypal&txn=${encodedTxn}&amount=${encodedAmount}` });
                                      });
                                    }
                                  }
                            });
                        });
                      })
                      .catch((decErr) => conn.rollback(() => next(decErr)));
                    }
                }
              );
            });
          }).catch((shipErr) => conn.rollback(() => {
            if (shipErr && shipErr.message === 'NO_SHIP_METHOD') return res.status(400).json({ error: 'No shipping method available' });
            return next(shipErr);
          }));
        });
      });
    });
  } catch (ex) {
    next(ex);
  }
}

module.exports = { createOrder, captureOrder };
