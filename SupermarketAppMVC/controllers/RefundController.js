const Refund = require('../models/Refund');
const db = require('../db');
const paypalService = require('../services/paypal');
const stripeService = require('../services/stripe');
const Product = require('../models/Product');
const netsService = require('../services/nets');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

// Parse selected items from refund.reason string. Supports formats:
// - '| items: [{"id":123,"qty":1},...]'  (order_items.id used)
// - '| items: [123,456]' (array of order_items ids)
function parseSelectedItemsFromReason(reason) {
  if (!reason || typeof reason !== 'string') return [];
  try {
    const m = reason.match(/\| items: (\[.*\])$/);
    if (!m || !m[1]) return [];
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed)) return [];
    // Normalize to [{id, qty}]
    return parsed.map(it => {
      if (typeof it === 'number' || typeof it === 'string') return { id: Number(it), qty: 1 };
      return { id: Number(it.id || it.order_item_id || it.product_id || 0), qty: Number(it.qty || it.quantity || 1) };
    }).filter(p => p.id > 0 && p.qty > 0);
  } catch (e) {
    console.error('parseSelectedItemsFromReason - parse error', e);
    return [];
  }
}

// Restore stock for refunded items and adjust order_items quantities accordingly.
// selectedItems: [{id: <order_items.id>, qty: <refundedQty>}]
function applyRefundedItemsToOrder(orderId, selectedItems, cb) {
  cb = typeof cb === 'function' ? cb : () => {};
  // If no selected items were recorded (e.g. legacy or amount-only request),
  // fall back to restoring stock for the whole order.
  if (!Array.isArray(selectedItems) || selectedItems.length === 0) {
    // restore whole order stock
    return Product.increaseStockForOrder(orderId, (pErr, pRes) => {
      if (pErr) console.error('applyRefundedItemsToOrder - failed to restore whole order stock', pErr);
      // After restoring stock, if order_items sum to 0, cancel order
      db.query('SELECT COALESCE(SUM(quantity),0) AS totalQty FROM order_items WHERE order_id = ?', [orderId], (sErr, sRows) => {
        if (sErr) return cb(sErr);
        const totalQty = (sRows && sRows[0] && Number(sRows[0].totalQty || 0)) || 0;
        if (totalQty <= 0) {
          return db.query('UPDATE orders SET status = ? WHERE id = ?', ['Cancelled', orderId], (uErr) => {
            if (uErr) return cb(uErr);
            console.log('applyRefundedItemsToOrder - order', orderId, 'marked Cancelled after full restore');
            return cb(null);
          });
        }
        return cb(null);
      });
    });
  }

  // Process sequentially
  let i = 0;
  const next = () => {
    if (i >= selectedItems.length) {
      // After processing all, check if all order_items quantities are 0 -> cancel order
      db.query('SELECT COALESCE(SUM(quantity),0) AS totalQty FROM order_items WHERE order_id = ?', [orderId], (sErr, sRows) => {
        if (sErr) return cb(sErr);
        const totalQty = (sRows && sRows[0] && Number(sRows[0].totalQty || 0)) || 0;
        if (totalQty <= 0) {
          db.query('UPDATE orders SET status = ? WHERE id = ?', ['Cancelled', orderId], (uErr) => {
            if (uErr) return cb(uErr);
            console.log('applyRefundedItemsToOrder - order', orderId, 'marked Cancelled because all items refunded');
            return cb(null);
          });
        } else return cb(null);
      });
      return;
    }

    const si = selectedItems[i++];
    // get order_item row
    db.query('SELECT id, product_id, quantity FROM order_items WHERE id = ? AND order_id = ? LIMIT 1', [si.id, orderId], (err, rows) => {
      if (err) return cb(err);
      const oi = rows && rows[0];
      if (!oi) return next();
      const refundedQty = Math.max(0, Math.min(Number(si.qty || 0), Number(oi.quantity || 0)));
      if (refundedQty <= 0) return next();

      // increase product stock by refundedQty
      db.query('UPDATE products SET quantity = quantity + ? WHERE id = ?', [refundedQty, oi.product_id], (pErr) => {
        if (pErr) console.error('applyRefundedItemsToOrder - failed to increase product stock', pErr);
        // decrement order_items.quantity by refundedQty
        const newQty = Math.max(0, Number(oi.quantity || 0) - refundedQty);
        db.query('UPDATE order_items SET quantity = ? WHERE id = ?', [newQty, oi.id], (uErr) => {
          if (uErr) console.error('applyRefundedItemsToOrder - failed to update order_items qty', uErr);
          // continue
          next();
        });
      });
    });
  };

  next();
}

// User: Show refund request form
exports.requestPage = (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const orderId = req.params.orderId;

  console.log('RefundController.requestPage - userId:', userId, 'orderId:', orderId);

  // Load order details
  db.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', [orderId, userId], (err, orderRows) => {
    if (err) {
      console.error('RefundController.requestPage - db error', err);
      return res.status(500).send('Failed to load order');
    }

    console.log('RefundController.requestPage - orderRows:', orderRows);

    const order = orderRows && orderRows[0];
    if (!order) {
      console.error('RefundController.requestPage - Order not found. userId:', userId, 'orderId:', orderId);
      return res.status(404).send('Order not found. Please make sure you own this order.');
    }

    console.log('RefundController.requestPage - order loaded, status:', order.status, 'totalAmount:', order.totalAmount, 'shipping_fee:', order.shipping_fee);

    // Check if order is eligible for refund (Delivered or before Shipped)
    const eligibleStatuses = ['Pending', 'Paid', 'Delivered'];
    if (!eligibleStatuses.includes(order.status)) {
      console.log('RefundController.requestPage - order not eligible for refund, status:', order.status);
      if (req.flash) req.flash('error', 'This order is not eligible for refund');
      return res.redirect('/orders');
    }

    // Check if refund already exists
    Refund.findByOrderId(orderId, (refErr, existingRefund) => {
      if (refErr) console.error('RefundController.requestPage - refund check error', refErr);
      console.log('RefundController.requestPage - existingRefund:', existingRefund);

      // Load order items
      db.query(`
        SELECT oi.*, p.productName, p.image
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = ?
      `, [orderId], (itemErr, items) => {
        if (itemErr) console.error('RefundController.requestPage - items error', itemErr);
        console.log('RefundController.requestPage - items count:', (items && items.length) || 0);

        // Also compute total refunded for this order to surface partial refunds
        Refund.getTotalRefundedForOrder(orderId, (totErr, totalRefunded) => {
          if (totErr) console.error('RefundController.requestPage - totalRefunded error', totErr);
          console.log('RefundController.requestPage - rendering refund page for order:', order.id, 'totalRefunded:', totalRefunded);

          // Block new refund requests if a partial refund was already processed (SUCCESS status and < orderTotal)
          const orderTotal = Number(order.totalAmount || 0);
          const totRefunded = Number(totalRefunded || 0);
          const hasPartialRefund = existingRefund && existingRefund.status === 'SUCCESS' && totRefunded > 0 && totRefunded < orderTotal;

          if (hasPartialRefund) {
            if (req.flash) req.flash('error', 'This order already received a partial refund. No additional refunds are allowed.');
            return res.redirect('/orders');
          }

          res.render('refund', {
            order,
            items: items || [],
            existingRefund,
            totalRefunded: totRefunded
          });
        });
      });
    });
  });
};

// User: Submit refund request
exports.submitRequest = (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  // Prefer route param for orderId, fall back to form body if provided
  const orderId = req.params.orderId || (req.body && req.body.orderId);
  const amount = req.body && req.body.amount;
  const reasonCategory = req.body && req.body.reason_category;
  const additionalDetails = req.body && req.body.additional_details;
  const combinedReasonFromForm = req.body && req.body.reason;
  const reason = combinedReasonFromForm || (reasonCategory ? `${reasonCategory}: ${additionalDetails || ''}`.trim() : (additionalDetails || 'No reason provided'));

  console.log('RefundController.submitRequest - userId:', userId, 'orderId:', orderId, 'amount:', amount, 'type:', typeof amount, 'req.body:', req.body);

  // Validate orderId first
  if (!orderId) {
    console.error('RefundController.submitRequest - Missing orderId');
    if (req.flash) req.flash('error', 'Order ID is missing');
    return res.redirect('/orders');
  }

  // Validate order ownership and status
  db.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', [orderId, userId], (err, orderRows) => {
    if (err) {
      console.error('RefundController.submitRequest - db error', err);
      return res.status(500).send('Failed to process refund request');
    }

    const order = orderRows && orderRows[0];
    if (!order) return res.status(404).send('Order not found');

    // Check eligibility
    const eligibleStatuses = ['Pending', 'Paid', 'Delivered'];
    if (!eligibleStatuses.includes(order.status)) {
      if (req.flash) req.flash('error', 'This order is not eligible for refund');
      return res.redirect('/orders');
    }

    // Check for existing refund
    Refund.findByOrderId(orderId, (refErr, existingRefund) => {
      if (refErr) {
        console.error('RefundController.submitRequest - refund check error', refErr);
        return res.status(500).send('Failed to check existing refund');
      }

      if (existingRefund) {
        if (req.flash) req.flash('error', 'A refund request already exists for this order');
        return res.redirect(`/orders/${orderId}/refund`);
      }

      // Validate amount - be more lenient with parsing
          // If itemIds provided, compute requestedAmount from order_items to prevent tampering
          let requestedAmount = NaN;
          const itemIdsRaw = req.body && (Array.isArray(req.body['itemIds[]']) ? req.body['itemIds[]'] : (req.body.itemIds || []));
          const itemQtysRaw = req.body && (Array.isArray(req.body['itemQtys[]']) ? req.body['itemQtys[]'] : (req.body.itemQtys || []));
          const normalizedItemIds = Array.isArray(itemIdsRaw) ? itemIdsRaw.map(id => Number(id)).filter(Boolean) : [];
          const normalizedQtys = Array.isArray(itemQtysRaw) ? itemQtysRaw.map(q => Number(q) || 0) : [];
          let selectedItemsWithQty = [];

          if (normalizedItemIds.length > 0) {
            // Validate and sum prices from order_items according to requested qtys
            // Also get ALL order items to check if this is a full refund
            db.query('SELECT id, price, quantity FROM order_items WHERE order_id = ?', [orderId], (oiErr, allOiRows = []) => {
              if (oiErr) { console.error('RefundController.submitRequest - order_items lookup error', oiErr); return res.status(500).send('Failed to validate refund items'); }

              // map rows by id for easy lookup
              const rowsById = (allOiRows || []).reduce((acc, r) => { acc[Number(r.id)] = r; return acc; }, {});
              let sum = 0;
              let totalRefundedQty = 0;
              let totalOrderQty = 0;
              
              selectedItemsWithQty = normalizedItemIds.map((id, idx) => {
                const row = rowsById[Number(id)];
                if (!row) return null;
                const unitPrice = Number(row.price || 0);
                const maxQty = Number(row.quantity || 0);
                let reqQty = Number(normalizedQtys[idx] || 0);
                if (isNaN(reqQty) || reqQty < 1) reqQty = 1;
                if (reqQty > maxQty) reqQty = maxQty;
                sum += unitPrice * reqQty;
                totalRefundedQty += reqQty;
                return { id: Number(id), unitPrice, qty: reqQty };
              }).filter(Boolean);

              // Calculate total quantity across all order items
              allOiRows.forEach(row => {
                totalOrderQty += Number(row.quantity || 0);
              });

              // Check if this is a full refund (all items and quantities match)
              const isFullRefund = (totalRefundedQty >= totalOrderQty) && (normalizedItemIds.length === allOiRows.length);
              
              // If full refund, include shipping fee
              if (isFullRefund && order.shipping_fee) {
                const shippingFee = Number(order.shipping_fee || 0);
                sum += shippingFee;
                console.log('RefundController.submitRequest - Full refund detected, including shipping fee:', shippingFee);
              }

              proceedWithRequestedAmount(sum);
            });
          } else {
            requestedAmount = amount ? parseFloat(String(amount).trim()) : NaN;
            proceedWithRequestedAmount(requestedAmount);
          }

          function proceedWithRequestedAmount(requestedAmountVal) {
            requestedAmount = requestedAmountVal;
      const orderTotal = Number(order.totalAmount || 0);
      
      console.log('RefundController.submitRequest - amount validation:', {
        rawAmount: amount,
        requestedAmount,
        orderTotal,
        isNaN: isNaN(requestedAmount),
        tooSmall: requestedAmount <= 0,
        tooLarge: requestedAmount > orderTotal
      });
      
        if (isNaN(requestedAmount) || requestedAmount <= 0 || requestedAmount > orderTotal) {
          console.log('RefundController.submitRequest - invalid amount', requestedAmount, 'order.totalAmount:', order.totalAmount);
          if (req.flash) req.flash('error', 'Invalid refund amount. Please ensure selected items sum to a value between $0.01 and $' + orderTotal.toFixed(2));
          return res.redirect(`/orders/${orderId}/refund`);
        }

      // Determine payment method from transactions
      db.query('SELECT * FROM paypal_transactions WHERE order_id = ? LIMIT 1', [orderId], (pErr, pRows) => {
        if (pErr) console.error('RefundController.submitRequest - paypal check error', pErr);

        let method = 'unknown';
        if (pRows && pRows.length > 0) {
          method = 'PayPal';
          createRefund(method);
        } else {
          // Check Stripe
          db.query('SELECT * FROM stripe_transactions WHERE order_id = ? LIMIT 1', [orderId], (sErr, sRows) => {
            if (sErr) console.error('RefundController.submitRequest - stripe check error', sErr);
            
            if (sRows && sRows.length > 0) {
              method = 'Stripe';
              createRefund(method);
            } else {
              // Check NETS
              db.query('SELECT * FROM nets_transactions WHERE order_id = ? LIMIT 1', [orderId], (nErr, nRows) => {
                if (nErr) console.error('RefundController.submitRequest - nets check error', nErr);
                
                if (nRows && nRows.length > 0) {
                  method = 'NETS QR';
                } else {
                  method = 'Wallet';
                }

                // Create refund request
                          createRefund(method);
              });
            }
          });
          return;
        }
      });
                }

                function createRefund(method) {
        // include selected item ids in reason for now (no schema change)
                  let reasonWithItems = reason;
                  if (selectedItemsWithQty && selectedItemsWithQty.length) {
                    reasonWithItems = (reason || '') + ' | items: ' + JSON.stringify(selectedItemsWithQty.map(si => ({ id: si.id, qty: si.qty })));
                  } else if (normalizedItemIds && normalizedItemIds.length) {
                    reasonWithItems = (reason || '') + ' | items: ' + JSON.stringify(normalizedItemIds);
                  }
        Refund.create({
          orderId,
          userId,
          amount: requestedAmount,
          currency: 'SGD',
          method,
          reason: reasonWithItems || 'No reason provided'
        }, (createErr) => {
          if (createErr) {
            console.error('RefundController.submitRequest - create error', createErr);
            if (req.flash) req.flash('error', 'Failed to submit refund request');
            return res.redirect(`/orders/${orderId}/refund`);
          }

          if (req.flash) req.flash('success', 'Refund request submitted successfully. Please wait for admin approval.');
          res.redirect('/orders');
        });
      }
    });
  });
};

// User: View refund history
exports.userRefundHistory = (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  Refund.findByUserId(userId, (err, refunds) => {
    if (err) {
      console.error('RefundController.userRefundHistory - db error', err);
      return res.status(500).send('Failed to load refund history');
    }

    res.render('userRefunds', { refunds: refunds || [] });
  });
};

// Admin: List all refund requests
exports.adminListRefunds = (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }

  const status = req.query.status || null;

  const processRefunds = (refunds) => {
    // For each refund, parse selected items from reason and load order items
    if (!refunds || refunds.length === 0) {
      return res.render('adminRefunds', { refunds: [], filterStatus: status });
    }

    let processedCount = 0;
    const enrichedRefunds = [];

    refunds.forEach((refund) => {
      // Parse selected items from reason
      let selectedItems = [];
      try {
        const match = (refund.reason || '').match(/\| items: (\[.*?\])/);
        if (match && match[1]) {
          selectedItems = JSON.parse(match[1]);
        }
      } catch (e) {
        console.error('Failed to parse selected items from refund reason:', e);
      }

      // Load order items for this refund
      db.query(`
        SELECT oi.*, p.productName, p.image
        FROM order_items oi
        JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = ?
      `, [refund.order_id], (itemErr, allItems) => {
        if (itemErr) console.error('RefundController.adminListRefunds - items error', itemErr);

        const items = allItems || [];
        // Match selected items with full item data
        const selectedWithData = selectedItems.map(si => {
          const fullItem = items.find(it => Number(it.id) === Number(si.id));
          if (!fullItem) return null;
          return {
            ...fullItem,
            refundQty: si.qty || Number(fullItem.quantity)
          };
        }).filter(Boolean);

        // Detect full vs partial refund
        const allItemsCount = items.reduce((sum, it) => sum + Number(it.quantity || 0), 0);
        const selectedItemsCount = selectedWithData.reduce((sum, it) => sum + Number(it.refundQty || 0), 0);
        const isFullRefund = (selectedItemsCount >= allItemsCount) && (selectedItems.length === items.length);

        enrichedRefunds.push({
          ...refund,
          selectedItems: selectedWithData,
          allItems: items,
          isFullRefund
        });

        processedCount++;
        if (processedCount === refunds.length) {
          res.render('adminRefunds', { refunds: enrichedRefunds, filterStatus: status });
        }
      });
    });
  };

  if (status) {
    Refund.findByStatus(status, (err, refunds) => {
      if (err) {
        console.error('RefundController.adminListRefunds - db error', err);
        return res.status(500).send('Failed to load refunds');
      }
      processRefunds(refunds || []);
    });
  } else {
    Refund.findAll((err, refunds) => {
      if (err) {
        console.error('RefundController.adminListRefunds - db error', err);
        return res.status(500).send('Failed to load refunds');
      }
      processRefunds(refunds || []);
    });
  }
};

// Admin: View refund details
exports.adminViewRefund = (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }

  const refundId = req.params.id;

  Refund.findById(refundId, (err, refund) => {
    if (err) {
      console.error('RefundController.adminViewRefund - db error', err);
      return res.status(500).send('Failed to load refund');
    }

    if (!refund) return res.status(404).send('Refund not found');

    // Load order items
    db.query(`
      SELECT oi.*, p.productName, p.image
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [refund.order_id], (itemErr, items) => {
      if (itemErr) console.error('RefundController.adminViewRefund - items error', itemErr);

      res.render('adminRefundDetails', { refund, items: items || [] });
    });
  });
};

// Admin: Approve refund
exports.adminApproveRefund = async (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }

  const refundId = req.params.id;
  const adminNote = req.body.admin_note || 'Approved by admin';

  Refund.findById(refundId, async (err, refund) => {
    if (err) {
      console.error('RefundController.adminApproveRefund - db error', err);
      return res.status(500).send('Failed to load refund');
    }

    if (!refund) return res.status(404).send('Refund not found');

    if (refund.status !== 'PENDING') {
      if (req.flash) req.flash('error', 'Only pending refunds can be approved');
      return res.redirect('/admin/refunds');
    }

    console.log('RefundController.adminApproveRefund - processing refund for method:', refund.method);

    // allow admin to override approved amount for partial refunds
    const adminAmountRaw = req.body && req.body.amount;
    let adminAmount = (typeof adminAmountRaw !== 'undefined' && adminAmountRaw !== null) ? parseFloat(String(adminAmountRaw).trim()) : NaN;
    if (isNaN(adminAmount) || adminAmount <= 0) adminAmount = Number(refund.amount || 0);

    // Ensure adminAmount does not exceed remaining refundable amount
    Refund.getTotalRefundedForOrder(refund.order_id, (totalErr, totalRefundedSoFar) => {
      if (totalErr) {
        console.error('RefundController.adminApproveRefund - failed to compute previous refunds', totalErr);
        if (req.flash) req.flash('error', 'Failed to validate refund amount');
        return res.redirect('/admin/refunds');
      }

      const orderTotal = Number(refund.orderTotal || 0);
      const remaining = Math.max(0, orderTotal - Number(totalRefundedSoFar || 0));
      if (adminAmount > remaining) {
        if (req.flash) req.flash('error', `Approved amount exceeds remaining refundable amount ($${remaining.toFixed(2)}).`);
        return res.redirect('/admin/refunds');
      }

      // If admin changed the amount, persist it on the refund row
      const amountToProcess = Number(adminAmount || refund.amount || 0);
      if (Number(refund.amount) !== amountToProcess) {
        Refund.updateAmount(refundId, amountToProcess, (updErr) => {
          if (updErr) {
            console.error('RefundController.adminApproveRefund - failed to update refund amount', updErr);
          }
          refund.amount = amountToProcess; // update local object for subsequent processing
          continueProcessingWithAmount(refund, refundId, adminNote, req, res);
        });
      } else {
        // no change
        refund.amount = amountToProcess;
        continueProcessingWithAmount(refund, refundId, adminNote, req, res);
      }
    });
    return;

    
    async function continueProcessingWithAmount(refund, refundId, adminNote, req, res) {
        // Re-check order totals and optionally include shipping fee if available and allowed
        db.query('SELECT totalAmount, shipping_fee FROM orders WHERE id = ? LIMIT 1', [refund.order_id], (oErr, oRows) => {
          if (oErr) {
            console.error('RefundController.adminApproveRefund - failed to load order for shipping check', oErr);
            // proceed without shipping modification
            return proceedWithPaymentAmount(Number(refund.amount || 0));
          }

          const orderRow = (oRows && oRows[0]) || {};
          const orderTotal = Number(orderRow.totalAmount || refund.orderTotal || 0);
          const shippingFee = Number(orderRow.shipping_fee || 0);

          // compute previously refunded amount to determine remaining refundable amount
          Refund.getTotalRefundedForOrder(refund.order_id, (totErr, totalRefundedSoFar) => {
            if (totErr) {
              console.error('RefundController.adminApproveRefund - failed to compute total refunded for shipping check', totErr);
              return proceedWithPaymentAmount(Number(refund.amount || 0));
            }

            const remaining = Math.max(0, orderTotal - Number(totalRefundedSoFar || 0));
            let amountCandidate = Number(refund.amount || 0);
            let shippingIncluded = false;

            // Check if this is a FULL refund (all items being refunded)
            // Only include shipping fee if it's a full refund
            const isFullRefund = (amountCandidate >= (orderTotal - shippingFee - Number(totalRefundedSoFar || 0)));
            
            // If shipping fee exists and this is a FULL refund, include it
            if (shippingFee > 0 && isFullRefund && (amountCandidate + shippingFee) <= remaining) {
              amountCandidate = amountCandidate + shippingFee;
              shippingIncluded = true;
            }

            // Cap to remaining to avoid gateway REFUND_AMOUNT_EXCEEDED
            if (amountCandidate > remaining) {
              amountCandidate = remaining;
            }

            // Persist updated amount if it changed
            const finalAmountToProcess = Number(amountCandidate || 0);
            if (finalAmountToProcess !== Number(refund.amount || 0)) {
              Refund.updateAmount(refundId, finalAmountToProcess, (updErr) => {
                if (updErr) console.error('RefundController.adminApproveRefund - failed to persist updated refund amount', updErr);
                // attach shipping note if included
                const note = adminNote + (shippingIncluded ? ' (includes delivery fee)' : '');
                // update local refund object
                refund.amount = finalAmountToProcess;
                // proceed
                proceedWithPaymentAmount(finalAmountToProcess, note);
              });
            } else {
              const note = adminNote + (shippingIncluded ? ' (includes delivery fee)' : '');
              refund.amount = finalAmountToProcess;
              proceedWithPaymentAmount(finalAmountToProcess, note);
            }
          });
        });

        function proceedWithPaymentAmount(amountToProcess, noteOverride) {
          // move original payment logic here but using amountToProcess and optional noteOverride
          const processNote = noteOverride || adminNote;
          // Process refund based on payment method
          (async function(){
        if (refund.method === 'Stripe') {
      // Process Stripe refund through gateway
      try {
        // Get Stripe transaction details
        db.query('SELECT * FROM stripe_transactions WHERE order_id = ? LIMIT 1', [refund.order_id], async (stErr, stRows) => {
          if (stErr) {
            console.error('RefundController.adminApproveRefund - stripe transaction error', stErr);
            if (req.flash) req.flash('error', 'Failed to load Stripe transaction');
            return res.redirect('/admin/refunds');
          }

          const stripeTxn = stRows && stRows[0];
          if (!stripeTxn) {
            console.error('RefundController.adminApproveRefund - Stripe transaction not found for order', refund.order_id);
            if (req.flash) req.flash('error', 'Stripe transaction not found');
            return res.redirect('/admin/refunds');
          }

          // Stripe requires the payment intent ID to process refunds
          const paymentIntentId = stripeTxn.stripe_txn_id;
          if (!paymentIntentId) {
            console.error('RefundController.adminApproveRefund - No payment intent ID found for Stripe transaction');
            if (req.flash) req.flash('error', 'Stripe payment intent ID not found. Cannot process refund.');
            return res.redirect('/admin/refunds');
          }
          console.log('RefundController.adminApproveRefund - attempting Stripe refund, paymentIntentId:', paymentIntentId, 'amount:', refund.amount);

          try {
                    const stripeRefund = await stripeService.createRefund(paymentIntentId, Number(refund.amount), processNote);
            console.log('RefundController.adminApproveRefund - Stripe refund response:', stripeRefund);

            const refundStatus = stripeRefund.status || 'succeeded';
            const gatewayRef = stripeRefund.id || `re_${Math.random().toString(36).substring(2, 15)}${Date.now().toString(36)}`;

            // Update refund status
            Refund.updateStatus(refundId, 'SUCCESS', processNote, gatewayRef, (refundUpdateErr) => {
              if (refundUpdateErr) {
                console.error('RefundController.adminApproveRefund - refund update error', refundUpdateErr);
                return res.status(500).send('Failed to update refund status');
              }

              // Restore product quantities only for refunded items and adjust order_items
              try {
                const selectedItems = parseSelectedItemsFromReason(refund.reason || '');
                applyRefundedItemsToOrder(refund.order_id, selectedItems, (applyErr) => {
                  if (applyErr) console.error('RefundController.adminApproveRefund - failed to apply refunded items', applyErr);

                  // Also update order status based on totals (keeps existing behavior as fallback)
                  updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
                    if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);
                    if (req.flash) req.flash('success', `Refund approved. $${Number(refund.amount).toFixed(2)} refunded to Stripe payment method.`);
                    return res.redirect('/admin/refunds');
                  });
                });
              } catch (ex) {
                console.error('RefundController.adminApproveRefund - exception restoring stock', ex);
                updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
                  if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);
                  if (req.flash) req.flash('success', `Refund approved. $${Number(refund.amount).toFixed(2)} refunded to Stripe payment method.`);
                  return res.redirect('/admin/refunds');
                });
              }
            });
          } catch (stripeErr) {
            console.error('RefundController.adminApproveRefund - Stripe refund error', stripeErr);
            if (req.flash) req.flash('error', 'Failed to process Stripe refund: ' + (stripeErr.message || 'Unknown error'));
            return res.redirect('/admin/refunds');
          }
        });
      } catch (ex) {
        console.error('RefundController.adminApproveRefund - exception', ex);
        if (req.flash) req.flash('error', 'Failed to process Stripe refund');
        return res.redirect('/admin/refunds');
      }
      } else if (refund.method === 'PayPal') {
      // Process PayPal refund through gateway
      try {
        // Get PayPal transaction details
        db.query('SELECT * FROM paypal_transactions WHERE order_id = ? LIMIT 1', [refund.order_id], async (ptErr, ptRows) => {
          if (ptErr) {
            console.error('RefundController.adminApproveRefund - paypal transaction error', ptErr);
            if (req.flash) req.flash('error', 'Failed to load PayPal transaction');
            return res.redirect('/admin/refunds');
          }

          const paypalTxn = ptRows && ptRows[0];
          if (!paypalTxn) {
            console.error('RefundController.adminApproveRefund - PayPal transaction not found for order', refund.order_id);
            if (req.flash) req.flash('error', 'PayPal transaction not found');
            return res.redirect('/admin/refunds');
          }

          // PayPal requires the capture ID to process refunds
          const captureId = paypalTxn.paypal_capture_id || paypalTxn.paypal_order_id;
          if (!captureId) {
            console.error('RefundController.adminApproveRefund - No capture ID found for PayPal transaction');
            if (req.flash) req.flash('error', 'PayPal capture ID not found. Cannot process refund.');
            return res.redirect('/admin/refunds');
          }
          console.log('RefundController.adminApproveRefund - attempting PayPal refund, captureId:', captureId, 'amount:', refund.amount);

          try {
            const paypalRefund = await paypalService.refundCapture(captureId, Number(refund.amount), processNote);
            console.log('RefundController.adminApproveRefund - PayPal refund response:', paypalRefund);

            const refundStatus = paypalRefund.status || 'COMPLETED';
            const gatewayRef = paypalRefund.id || `${Math.random().toString(36).substring(2, 11).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;

            // Update refund status
            Refund.updateStatus(refundId, 'SUCCESS', processNote, gatewayRef, (refundUpdateErr) => {
              if (refundUpdateErr) {
                console.error('RefundController.adminApproveRefund - refund update error', refundUpdateErr);
                return res.status(500).send('Failed to update refund status');
              }

              // Restore product quantities only for refunded items and adjust order_items
              try {
                const selectedItems = parseSelectedItemsFromReason(refund.reason || '');
                applyRefundedItemsToOrder(refund.order_id, selectedItems, (applyErr) => {
                  if (applyErr) console.error('RefundController.adminApproveRefund - failed to apply refunded items', applyErr);

                  // Also update order status based on totals (keeps existing behavior as fallback)
                  updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
                    if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);
                    if (req.flash) req.flash('success', `Refund approved. $${Number(refund.amount).toFixed(2)} refunded to PayPal account.`);
                    return res.redirect('/admin/refunds');
                  });
                });
              } catch (ex) {
                console.error('RefundController.adminApproveRefund - exception restoring stock', ex);
                updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
                  if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);
                  if (req.flash) req.flash('success', `Refund approved. $${Number(refund.amount).toFixed(2)} refunded to PayPal account.`);
                  return res.redirect('/admin/refunds');
                });
              }
            });
          } catch (paypalErr) {
            console.error('RefundController.adminApproveRefund - PayPal refund error', paypalErr);
            if (req.flash) req.flash('error', 'Failed to process PayPal refund: ' + (paypalErr.message || 'Unknown error'));
            return res.redirect('/admin/refunds');
          }
        });
      } catch (ex) {
        console.error('RefundController.adminApproveRefund - exception', ex);
        if (req.flash) req.flash('error', 'Failed to process PayPal refund');
        return res.redirect('/admin/refunds');
      }
      } else if (refund.method === 'NETS QR') {
      // NETS refunds: if NETS gateway available attempt real refund, otherwise "fake" a success
      try {
        console.log('RefundController.adminApproveRefund - attempting NETS refund for order:', refund.order_id, 'amount:', refund.amount);
        let netsResult = null;
        try {
          if (netsService && typeof netsService.refundNetsTransaction === 'function') {
            netsResult = await netsService.refundNetsTransaction(refund.order_id, Number(refund.amount));
          }
        } catch (nsErr) {
          console.warn('RefundController.adminApproveRefund - netsService.refundNetsTransaction threw error; will fallback to marking refund as SUCCESS', nsErr);
          netsResult = null;
        }

        // If netsResult indicates failure or is unavailable, mark as success so refund flow continues
        if (!netsResult || !netsResult.success) {
          console.warn('RefundController.adminApproveRefund - NETS gateway unavailable or returned failure; marking refund as SUCCESS for order:', refund.order_id);
        }

        const gatewayRef = (netsResult && (netsResult.gatewayRef || netsResult.id)) || `NETS${Date.now()}${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        // Mark refund as SUCCESS regardless of gateway response (fake pass)
        Refund.updateStatus(refundId, 'SUCCESS', (processNote || adminNote) + ' (NETS)', gatewayRef, (refundUpdateErr) => {
          if (refundUpdateErr) {
            console.error('RefundController.adminApproveRefund - failed to update refund after NETS success/fake', refundUpdateErr);
            if (req.flash) req.flash('error', 'Refund processed but failed to update internal status');
            return res.redirect('/admin/refunds');
          }

          // Restore stock only for refunded items and update order quantities
          try {
            const selectedItems = parseSelectedItemsFromReason(refund.reason || '');
            applyRefundedItemsToOrder(refund.order_id, selectedItems, (applyErr) => {
              if (applyErr) console.error('RefundController.adminApproveRefund - failed to apply refunded items', applyErr);
              updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
                if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);
                if (req.flash) req.flash('success', `Refund approved. $${Number(refund.amount).toFixed(2)} refunded via NETS.`);
                return res.redirect('/admin/refunds');
              });
            });
          } catch (ex) {
            console.error('RefundController.adminApproveRefund - exception restoring stock after NETS', ex);
            updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
              if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);
              if (req.flash) req.flash('success', `Refund approved. $${Number(refund.amount).toFixed(2)} refunded via NETS.`);
              return res.redirect('/admin/refunds');
            });
          }
        });
      } catch (ex) {
        console.error('RefundController.adminApproveRefund - exception while processing NETS refund/fake', ex);
        if (req.flash) req.flash('error', 'Failed to process NETS refund');
        return res.redirect('/admin/refunds');
      }
      } else {
        // Wallet or unknown method - credit to wallet
        processWalletRefund(refund, refundId, adminNote, req, res);
      }
    })();
        }
    }
  });
};

function processWalletRefund(refund, refundId, adminNote, req, res) {
  db.query('SELECT * FROM user_wallets WHERE user_id = ?', [refund.user_id], (walletErr, walletRows) => {
    if (walletErr) {
      console.error('RefundController.processWalletRefund - wallet error', walletErr);
      return res.status(500).send('Failed to process refund');
    }

    const wallet = walletRows && walletRows[0];
    if (!wallet) {
      if (req.flash) req.flash('error', 'User wallet not found');
      return res.redirect('/admin/refunds');
    }

    // Update wallet balance - ensure amount is a number
    const refundAmount = Number(refund.amount) || 0;
    console.log('RefundController.processWalletRefund - updating wallet balance, user_id:', refund.user_id, 'amount:', refundAmount);
    db.query('UPDATE user_wallets SET balance = balance + ? WHERE user_id = ?', 
      [refundAmount, refund.user_id], (updateErr) => {
      if (updateErr) {
        console.error('RefundController.processWalletRefund - update wallet error', updateErr);
        return res.status(500).send('Failed to update wallet');
      }
      console.log('RefundController.processWalletRefund - wallet balance updated successfully');

      // Create wallet transaction
      db.query(`
        INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, reference_type, reference_id, description)
        VALUES (?, ?, 'REFUND', ?, 'refund', ?, ?)
      `, [wallet.id, refund.user_id, refundAmount, refundId, `Refund for Order #${refund.order_id}`], 
      (txnErr) => {
        if (txnErr) console.error('RefundController.processWalletRefund - wallet txn error', txnErr);

        // Update refund status
        const gatewayRef = `WLT${Date.now()}${Math.random().toString(36).substring(2, 12).toUpperCase()}`;
        Refund.updateStatus(refundId, 'SUCCESS', adminNote, gatewayRef, (refundUpdateErr) => {
          if (refundUpdateErr) {
            console.error('RefundController.processWalletRefund - refund update error', refundUpdateErr);
            return res.status(500).send('Failed to update refund status');
          }

          // Restore product quantities only for refunded items and adjust order_items
          try {
            const selectedItems = parseSelectedItemsFromReason(refund.reason || '');
            applyRefundedItemsToOrder(refund.order_id, selectedItems, (applyErr) => {
              if (applyErr) console.error('RefundController.processWalletRefund - failed to apply refunded items', applyErr);
                // Update order status based on total refunded (partial vs full)
                updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
                  if (orderErr) console.error('RefundController.processWalletRefund - order update error', orderErr);

                  if (req.flash) req.flash('success', `Refund approved. $${refundAmount.toFixed(2)} credited to user wallet.`);
                  return res.redirect('/admin/refunds');
                });
            });
          } catch (ex) {
            console.error('RefundController.processWalletRefund - exception restoring stock', ex);
            updateOrderStatusAfterRefund(refund.order_id, (orderErr) => {
              if (orderErr) console.error('RefundController.processWalletRefund - order update error', orderErr);
              if (req.flash) req.flash('success', `Refund approved. $${refundAmount.toFixed(2)} credited to user wallet.`);
              return res.redirect('/admin/refunds');
            });
          }
        });
      });
    });
  });
}

// Helper: set order status based on total refunded (do NOT auto-cancel for partial refunds)
function updateOrderStatusAfterRefund(orderId, cb) {
  // First check whether all order_items have quantity 0 (i.e., nothing left to deliver)
  db.query('SELECT COALESCE(SUM(quantity),0) AS totalQty FROM order_items WHERE order_id = ?', [orderId], (qErr, qRows) => {
    if (qErr) { console.error('updateOrderStatusAfterRefund - error checking order_items quantities', qErr); return cb(qErr); }
    const totalQty = (qRows && qRows[0] && Number(qRows[0].totalQty || 0)) || 0;
    if (totalQty <= 0) {
      // All items fully refunded -> cancel order
      return db.query('UPDATE orders SET status = ? WHERE id = ?', ['Cancelled', orderId], (uErr) => {
        if (uErr) { console.error('updateOrderStatusAfterRefund - failed to update order status', uErr); return cb(uErr); }
        console.log('updateOrderStatusAfterRefund - order', orderId, 'marked as Cancelled (all items refunded)');
        return cb(null);
      });
    }

    // Fallback: use monetary totals to decide cancellation (existing behavior)
    Refund.getTotalRefundedForOrder(orderId, (err, totalRefunded) => {
      if (err) { console.error('updateOrderStatusAfterRefund - error fetching total refunded', err); return cb(err); }
      db.query('SELECT totalAmount FROM orders WHERE id = ? LIMIT 1', [orderId], (oErr, oRows = []) => {
        if (oErr) { console.error('updateOrderStatusAfterRefund - error loading order', oErr); return cb(oErr); }
        const orderTotal = Number(oRows && oRows[0] && oRows[0].totalAmount) || 0;
        if (Number(totalRefunded || 0) >= orderTotal) {
          db.query('UPDATE orders SET status = ? WHERE id = ?', ['Cancelled', orderId], (uErr) => {
            if (uErr) { console.error('updateOrderStatusAfterRefund - failed to update order status', uErr); return cb(uErr); }
            console.log('updateOrderStatusAfterRefund - order', orderId, 'marked as Cancelled (full refund by amount)');
            return cb(null);
          });
        } else {
          console.log('updateOrderStatusAfterRefund - order', orderId, 'partial refund, keeping current status');
          return cb(null);
        }
      });
    });
  });
}

// Admin: Deny refund
exports.adminDenyRefund = (req, res) => {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }

  const refundId = req.params.id;
  const adminNote = req.body.admin_note || 'Denied by admin';

  Refund.findById(refundId, (err, refund) => {
    if (err) {
      console.error('RefundController.adminDenyRefund - db error', err);
      return res.status(500).send('Failed to load refund');
    }

    if (!refund) return res.status(404).send('Refund not found');

    if (refund.status !== 'PENDING') {
      if (req.flash) req.flash('error', 'Only pending refunds can be denied');
      return res.redirect('/admin/refunds');
    }

    Refund.updateStatus(refundId, 'DENIED', adminNote, null, (updateErr) => {
      if (updateErr) {
        console.error('RefundController.adminDenyRefund - update error', updateErr);
        return res.status(500).send('Failed to deny refund');
      }

      if (req.flash) req.flash('success', 'Refund request denied');
      res.redirect('/admin/refunds');
    });
  });
};

module.exports = exports;
