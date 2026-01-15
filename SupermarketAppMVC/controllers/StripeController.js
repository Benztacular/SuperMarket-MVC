const stripeService = require('../services/stripe');
const db = require('../db');
const StripeTransaction = require('../models/StripeTransaction');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

/**
 * Create a Stripe Payment Intent
 */
async function createPaymentIntent(req, res, next) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Compute total from cart_items
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

      // Include shipping fee
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
        console.error('createPaymentIntent shipping error', shipErr);
        return res.status(400).json({ error: 'No shipping method available' });
      }

      const itemsTotal = items.reduce((s, it) => s + Number(it.price || 0) * Number(it.quantity || 0), 0);
      const total = itemsTotal + shippingFee;
      if (total <= 0) return res.status(400).json({ error: 'Invalid total' });

      // Create Stripe Payment Intent
      const paymentIntent = await stripeService.createPaymentIntent(total, {
        userId: userId.toString(),
        cartTotal: total.toString()
      });

      return res.json({ 
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: total 
      });
    });
  } catch (ex) {
    console.error('Stripe createPaymentIntent error:', ex);
    next(ex);
  }
}

/**
 * Confirm Stripe Payment and Create Order
 */
async function confirmPayment(req, res, next) {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    
    const { paymentIntentId } = req.body || {};
    if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId' });

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripeService.retrievePaymentIntent(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: 'Payment not succeeded', 
        status: paymentIntent.status 
      });
    }

    // Create local order in transaction
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
        if (!cartRows || cartRows.length === 0) {
          return conn.rollback(() => res.status(400).json({ error: 'Cart empty' }));
        }

        // Check stock
        for (const r of cartRows) {
          if (Number(r.quantity) > Number(r.stock)) {
            return conn.rollback(() => res.status(400).json({ 
              error: `Insufficient stock for ${r.productName}` 
            }));
          }
        }

        // Resolve delivery address
        const selectedAddressId = req.session?.selectedAddressId || null;
        const addressSql = 'SELECT id FROM delivery_addresses WHERE user_id = ? ORDER BY (id = ?) DESC, is_default DESC, id ASC LIMIT 1';
        
        conn.query(addressSql, [userId, selectedAddressId || 0], (addrErr, addrRows = []) => {
          if (addrErr) return conn.rollback(() => next(addrErr));
          if (!addrRows.length) {
            return conn.rollback(() => res.status(400).json({ 
              error: 'Please add a delivery address' 
            }));
          }
          const deliveryAddressId = addrRows[0].id;

          // Resolve shipping method
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
            if (!req.session.selectedShippingMethodId) {
              req.session.selectedShippingMethodId = shippingMethodId;
            }

            const itemsTotal = cartRows.reduce((s, r) => s + Number(r.unit_price || 0) * Number(r.quantity || 0), 0);
            const total = itemsTotal + shippingFee;

            // Create order
            conn.query(
              'INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, NOW(), ?, ?, NOW())',
              [userId, deliveryAddressId, shippingMethodId, shippingFee, total, 'Paid'],
              (oErr, oResult) => {
                if (oErr) return conn.rollback(() => next(oErr));
                const orderId = oResult.insertId;

                // Insert order items and decrement stock
                let inserted = 0;
                for (const r of cartRows) {
                  conn.query(
                    'INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES (?, ?, ?, ?, NOW())',
                    [orderId, r.product_id, r.quantity, r.unit_price],
                    (oiErr) => {
                      if (oiErr) return conn.rollback(() => next(oiErr));
                      
                      conn.query(
                        'UPDATE products SET quantity = quantity - ? WHERE id = ?',
                        [r.quantity, r.product_id],
                        (pErr) => {
                          if (pErr) return conn.rollback(() => next(pErr));
                          
                          inserted++;
                          if (inserted === cartRows.length) {
                            // Create Stripe transaction record
                            const amount = paymentIntent.amount / 100; // Convert from cents
                            // Try to use latest_charge (present on PaymentIntent) first, fallback to charges.data[0].id
                            const stripeChargeId = paymentIntent.latest_charge || (paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data[0] && paymentIntent.charges.data[0].id) || null;
                            StripeTransaction.create({
                              userId: userId,
                              orderId: orderId,
                              stripeTxnId: paymentIntent.id,
                              stripeChargeId: stripeChargeId,
                              paymentStatus: 'success',
                              amount: amount,
                              currency: paymentIntent.currency.toUpperCase(),
                              paymentTime: new Date(),
                              rawResponse: paymentIntent
                            }, (stErr) => {
                              if (stErr) {
                                console.error('Failed to save Stripe transaction:', stErr);
                                // Don't rollback - payment succeeded
                              }

                              // Clear cart
                              conn.query('DELETE FROM cart_items WHERE user_id = ?', [userId], (delErr) => {
                                if (delErr) console.error('Failed to clear cart:', delErr);

                                conn.commit((commitErr) => {
                                  if (commitErr) return conn.rollback(() => next(commitErr));

                                  // Clear session
                                  delete req.session.selectedAddressId;
                                  delete req.session.selectedShippingMethodId;

                                  return res.json({ 
                                    success: true, 
                                    redirect: `/payment/success?orderId=${orderId}` 
                                  });
                                });
                              });
                            });
                          }
                        }
                      );
                    }
                  );
                }
              }
            );
          }).catch((shipErr) => {
            return conn.rollback(() => res.status(400).json({ 
              error: 'Shipping method error: ' + shipErr.message 
            }));
          });
        });
      });
    });
  } catch (ex) {
    console.error('Stripe confirmPayment error:', ex);
    next(ex);
  }
}

module.exports = {
  createPaymentIntent,
  confirmPayment
};
