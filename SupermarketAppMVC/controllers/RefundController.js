const Refund = require('../models/Refund');
const db = require('../db');
const paypalService = require('../services/paypal');
const Product = require('../models/Product');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
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

        console.log('RefundController.requestPage - rendering refund page for order:', order.id);
        res.render('refund', {
          order,
          items: items || [],
          existingRefund
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
      const requestedAmount = amount ? parseFloat(String(amount).trim()) : NaN;
      const orderTotal = Number(order.totalAmount || 0);
      
      console.log('RefundController.submitRequest - amount validation:', {
        rawAmount: amount,
        requestedAmount,
        orderTotal,
        isNaN: isNaN(requestedAmount),
        tooSmall: requestedAmount <= 0,
        tooLarge: requestedAmount > orderTotal
      });
      
      if (!amount || isNaN(requestedAmount) || requestedAmount <= 0 || requestedAmount > orderTotal) {
        console.log('RefundController.submitRequest - invalid amount', requestedAmount, 'order.totalAmount:', order.totalAmount);
        if (req.flash) req.flash('error', 'Invalid refund amount. Please enter an amount between $0.01 and $' + orderTotal.toFixed(2));
        return res.redirect(`/orders/${orderId}/refund`);
      }

      // Determine payment method from transactions
      db.query('SELECT * FROM paypal_transactions WHERE order_id = ? LIMIT 1', [orderId], (pErr, pRows) => {
        if (pErr) console.error('RefundController.submitRequest - paypal check error', pErr);

        let method = 'unknown';
        if (pRows && pRows.length > 0) {
          method = 'PayPal';
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
          return;
        }

        createRefund(method);
      });

      function createRefund(method) {
        Refund.create({
          orderId,
          userId,
          amount: requestedAmount,
          currency: 'SGD',
          method,
          reason: reason || 'No reason provided'
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

  if (status) {
    Refund.findByStatus(status, (err, refunds) => {
      if (err) {
        console.error('RefundController.adminListRefunds - db error', err);
        return res.status(500).send('Failed to load refunds');
      }
      res.render('adminRefunds', { refunds: refunds || [], filterStatus: status });
    });
  } else {
    Refund.findAll((err, refunds) => {
      if (err) {
        console.error('RefundController.adminListRefunds - db error', err);
        return res.status(500).send('Failed to load refunds');
      }
      res.render('adminRefunds', { refunds: refunds || [], filterStatus: null });
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

    // Process refund based on payment method
    if (refund.method === 'PayPal') {
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
            const paypalRefund = await paypalService.refundCapture(captureId, Number(refund.amount), adminNote);
            console.log('RefundController.adminApproveRefund - PayPal refund response:', paypalRefund);

            const refundStatus = paypalRefund.status || 'COMPLETED';
            const gatewayRef = paypalRefund.id || `paypal_refund_${refundId}_${Date.now()}`;

            // Update refund status
            Refund.updateStatus(refundId, 'SUCCESS', adminNote, gatewayRef, (refundUpdateErr) => {
              if (refundUpdateErr) {
                console.error('RefundController.adminApproveRefund - refund update error', refundUpdateErr);
                return res.status(500).send('Failed to update refund status');
              }

              // Restore product quantities for the refunded order
              try {
                Product.increaseStockForOrder(refund.order_id, (pErr, pRes) => {
                  if (pErr) console.error('RefundController.adminApproveRefund - failed to restore product stock', pErr);

                  // Update order status regardless of stock restore result
                  db.query('UPDATE orders SET status = ? WHERE id = ?', ['Refunded', refund.order_id], (orderErr) => {
                    if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);

                    if (req.flash) req.flash('success', `Refund approved. $${refund.amount} refunded to PayPal account.`);
                    return res.redirect('/admin/refunds');
                  });
                });
              } catch (ex) {
                console.error('RefundController.adminApproveRefund - exception restoring stock', ex);
                db.query('UPDATE orders SET status = ? WHERE id = ?', ['Refunded', refund.order_id], (orderErr) => {
                  if (orderErr) console.error('RefundController.adminApproveRefund - order update error', orderErr);
                  if (req.flash) req.flash('success', `Refund approved. $${refund.amount} refunded to PayPal account.`);
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
      // NETS refunds would require NETS API integration
      // For now, fallback to wallet credit
      console.log('RefundController.adminApproveRefund - NETS refunds not yet implemented, crediting to wallet');
      processWalletRefund(refund, refundId, adminNote, req, res);
    } else {
      // Wallet or unknown method - credit to wallet
      processWalletRefund(refund, refundId, adminNote, req, res);
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

    // Update wallet balance
    db.query('UPDATE user_wallets SET balance = balance + ? WHERE user_id = ?', 
      [refund.amount, refund.user_id], (updateErr) => {
      if (updateErr) {
        console.error('RefundController.processWalletRefund - update wallet error', updateErr);
        return res.status(500).send('Failed to update wallet');
      }

      // Create wallet transaction
      db.query(`
        INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, reference_type, reference_id, description)
        VALUES (?, ?, 'REFUND', ?, 'refund', ?, ?)
      `, [wallet.id, refund.user_id, refund.amount, refundId, `Refund for Order #${refund.order_id}`], 
      (txnErr) => {
        if (txnErr) console.error('RefundController.processWalletRefund - wallet txn error', txnErr);

        // Update refund status
        const gatewayRef = `wallet_refund_${refundId}_${Date.now()}`;
        Refund.updateStatus(refundId, 'SUCCESS', adminNote, gatewayRef, (refundUpdateErr) => {
          if (refundUpdateErr) {
            console.error('RefundController.processWalletRefund - refund update error', refundUpdateErr);
            return res.status(500).send('Failed to update refund status');
          }

          // Restore product quantities for the refunded order
          try {
            Product.increaseStockForOrder(refund.order_id, (pErr, pRes) => {
              if (pErr) console.error('RefundController.processWalletRefund - failed to restore product stock', pErr);

              // Update order status regardless of stock restore result
              db.query('UPDATE orders SET status = ? WHERE id = ?', ['Refunded', refund.order_id], (orderErr) => {
                if (orderErr) console.error('RefundController.processWalletRefund - order update error', orderErr);

                if (req.flash) req.flash('success', `Refund approved. $${refund.amount} credited to user wallet.`);
                return res.redirect('/admin/refunds');
              });
            });
          } catch (ex) {
            console.error('RefundController.processWalletRefund - exception restoring stock', ex);
            db.query('UPDATE orders SET status = ? WHERE id = ?', ['Refunded', refund.order_id], (orderErr) => {
              if (orderErr) console.error('RefundController.processWalletRefund - order update error', orderErr);
              if (req.flash) req.flash('success', `Refund approved. $${refund.amount} credited to user wallet.`);
              return res.redirect('/admin/refunds');
            });
          }
        });
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
