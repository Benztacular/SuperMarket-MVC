const Wallet = require('../models/Wallet');
const Membership = require('../models/Membership');
const LoyaltyPoints = require('../models/LoyaltyPoints');
const db = require('../db');
// payment methods persistence disabled for wallet page (use tokenized flows)
const Stripe = require('stripe');
const stripe = (process.env.STRIPE_SECRET_KEY) ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const paypalService = require('../services/paypal');
const stripeService = require('../services/stripe');
const netsService = require('../services/nets');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

exports.page = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');
  
  Wallet.findByUserId(userId, (err, wallet) => {
    if (err) return next(err);
    
    const ensureWallet = (cb) => {
      if (wallet) return cb(null, wallet);
      Wallet.createForUser(userId, (cErr) => {
        if (cErr) return cb(cErr);
        Wallet.findByUserId(userId, cb);
      });
    };

    ensureWallet((e, w) => {
      if (e) return next(e);
      
      // Fetch transactions
      Wallet.getTransactionsByUserId(userId, (tErr, txs) => {
        if (tErr) return next(tErr);
        
        const flashErrors = typeof req.flash === 'function' ? req.flash('error') : [];
        const flashSuccess = typeof req.flash === 'function' ? req.flash('success') : [];
        const recentTx = (txs || []).slice(0, 5);
        const userData = req.session.user || {};

        // Use Membership model to get normalized name
        Membership.getNormalizedMembershipName(userId, (mErr, membershipName) => {
          if (mErr) console.error('Membership lookup error:', mErr);
          const membership = membershipName || 'Free';

          // Use LoyaltyPoints model to get account with progress
          LoyaltyPoints.getAccountWithProgress(userId, (lErr, loyalty) => {
            if (lErr) console.error('Loyalty account error:', lErr);
            const loyaltyData = loyalty || { points: 0, tier: 'Bronze', progress: 0, nextThreshold: 5000 };

            res.render('wallet', {
              wallet: w || { balance: 0.00 },
              transactions: recentTx || [],
              totalTransactions: (txs || []).length || 0,
              paymentMethods: [],
              stripePublishable: process.env.STRIPE_PUBLISHABLE_KEY || '',
              membership: membership,
              user: userData,
              loyalty: loyaltyData,
              error: flashErrors,
              success: flashSuccess
            });
          });
        });
      });
    });
  });
};

// API: paginated wallet transactions
exports.transactions = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });
  const page = Math.max(1, Number(req.query.page || 1));
  const per = Math.max(1, Math.min(100, Number(req.query.per || 5)));
  const offset = (page - 1) * per;

  const countSql = 'SELECT COUNT(*) AS cnt FROM wallet_transactions WHERE user_id = ?';
  db.query(countSql, [userId], (cErr, cRows = []) => {
    if (cErr) return res.status(500).json({ success: false, error: 'Count failed' });
    const total = (cRows && cRows[0] && Number(cRows[0].cnt)) || 0;
    const sql = 'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    db.query(sql, [userId, per, offset], (err, rows = []) => {
      if (err) return res.status(500).json({ success: false, error: 'Failed to load transactions' });
      return res.json({ success: true, transactions: rows || [], page, per, total });
    });
  });
};

// Helper: get or create stripe customer id stored on users table
async function getOrCreateStripeCustomer(userId, userEmail) {
  if (!stripe) throw new Error('Stripe not configured (STRIPE_SECRET_KEY missing)');
  return new Promise((resolve, reject) => {
    db.query('SELECT stripe_customer_id FROM users WHERE id = ? LIMIT 1', [Number(userId)], async (err, rows) => {
      if (err) return reject(err);
      const existing = rows && rows[0] ? rows[0].stripe_customer_id : null;
      if (existing) return resolve(existing);
      try {
        const cust = await stripe.customers.create({ email: userEmail || undefined, metadata: { userId: String(userId) } });
        db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255) NULL', [], () => {
          // Some MySQL versions don't support IF NOT EXISTS for ALTER COLUMN; ignore errors
          db.query('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [cust.id, Number(userId)], (uErr) => {
            if (uErr) return resolve(cust.id); // still resolve with cust.id even if DB update failed
            return resolve(cust.id);
          });
        });
      } catch (e) {
        return reject(e);
      }
    });
  });
}

// Create a SetupIntent for saving a card via Stripe Elements
exports.createSetupIntent = async (req, res, next) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured on server' });
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userEmail = req.session?.user?.email || undefined;
    const customerId = await getOrCreateStripeCustomer(userId, userEmail);
    const si = await stripe.setupIntents.create({ customer: customerId, usage: 'off_session' });
    return res.json({ client_secret: si.client_secret });
  } catch (err) {
    console.error('createSetupIntent error', err);
    return res.status(500).json({ error: err.message || 'Failed to create setup intent' });
  }
};

// Save Stripe PaymentMethod (received from client after confirmCardSetup)
exports.saveStripeMethod = async (req, res, next) => {
  try {
    if (!stripe) throw new Error('Stripe not configured');
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const pmId = req.body.payment_method || req.body.paymentMethod || req.body.pm;
    if (!pmId) return res.status(400).json({ error: 'payment_method required' });

    // retrieve payment method details
    const pm = await stripe.paymentMethods.retrieve(pmId);

    // ensure customer exists and attach payment method (do not save locally)
    const userEmail = req.session?.user?.email || undefined;
    const customerId = await getOrCreateStripeCustomer(userId, userEmail);
    if (!pm.customer) {
      await stripe.paymentMethods.attach(pmId, { customer: customerId });
    }

    // Return minimal method info to client but DO NOT persist to local DB
    return res.json({ ok: true, method: {
      id: pm.id,
      type: 'stripe',
      brand: pm.card?.brand || 'card',
      last4: pm.card?.last4 || null,
      exp_month: pm.card?.exp_month || null,
      exp_year: pm.card?.exp_year || null
    }});
  } catch (err) {
    console.error('saveStripeMethod error', err);
    return res.status(500).json({ error: err.message || 'Failed to save stripe method' });
  }
};

exports.topUp = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const raw = req.body.amount || req.body.topup || req.body.value;
  const amount = Number(String(raw || '').replace(/[,$\s]/g, '')) || 0;
  const method = (req.body.payment_method || '').toLowerCase();
  if (!amount || amount <= 0) {
    if (req.flash) req.flash('error', 'Invalid top-up amount');
    return res.redirect('/wallet');
  }

  // ensure wallet exists, then update balance and add a transaction
  Wallet.findByUserId(userId, (err, wallet) => {
    if (err) return next(err);
    const ensureAndTop = (cb) => {
      if (wallet) return cb(null, wallet);
      Wallet.createForUser(userId, (cErr) => {
        if (cErr) return cb(cErr);
        Wallet.findByUserId(userId, cb);
      });
    };

    ensureAndTop(async (e, w) => {
      if (e) return next(e);

      try {
        // route top-up by selected method
        if (method === 'paypal') {
          // build absolute return/cancel URLs so PayPal redirects back to our handlers
          const host = req.protocol + '://' + req.get('host');
          const returnUrl = `${host}/wallet/paypal/return`;
          const cancelUrl = `${host}/wallet?canceled=1`;

          // create PayPal order and redirect user to approval
          const order = await paypalService.createOrder(amount, returnUrl, cancelUrl);
          const approve = (order && order.links) ? order.links.find(l => l.rel === 'approve') : null;
          if (approve && approve.href) return res.redirect(approve.href);
          // fallback: show error
          if (req.flash) req.flash('error', 'Failed to initiate PayPal payment');
          return res.redirect('/wallet');
        }

        if (method === 'nets') {
          // Mark this session as a pending NETS wallet top-up so NETS polling
          // can apply the top-up to the wallet instead of treating it as a cart order.
          try {
            req.session.pendingNetsTopup = { amount: amount };
          } catch (sessErr) {
            // session middleware may not be available; log and continue to generate QR
            console.warn('Could not set session.pendingNetsTopup', sessErr);
          }
          // delegates to NETS service which renders QR page
          req.body.cartTotal = amount;
          return netsService.generateQrCode(req, res);
        }

        if (method === 'stripe') {
          if (!stripe) {
            if (req.flash) req.flash('error', 'Stripe not configured');
            return res.redirect('/wallet');
          }
          const host = req.protocol + '://' + req.get('host');
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            line_items: [{
              price_data: {
                currency: 'sgd',
                product_data: { name: 'FreshWallet Top-up' },
                unit_amount: Math.round(amount * 100)
              },
              quantity: 1
            }],
            success_url: `${host}/wallet/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${host}/wallet?canceled=1`,
            metadata: { userId: String(userId), purpose: 'wallet_topup' }
          });
          return res.redirect(303, session.url);
        }

        // default/manual: do the old behavior (no external payment)
        Wallet.updateBalanceByUserId(userId, amount, (uErr, updated) => {
          if (uErr) return next(uErr);
          const walletId = (updated && updated.id) || (w && w.id) || null;
          Wallet.addTransaction({
            wallet_id: walletId,
            user_id: userId,
            type: 'TOP_UP',
            amount: amount,
            reference_type: 'MANUAL',
            reference_id: null,
            description: `Top-up ${amount.toFixed(2)}`
          }, (tErr) => {
            if (tErr) return next(tErr);
            if (req.flash) req.flash('success', 'Wallet topped up (manual)');
            res.redirect('/wallet');
          });
        });
      } catch (ex) {
        return next(ex);
      }
    });
  });
};

// PayPal return / capture handler
exports.paypalReturn = async (req, res, next) => {
  try {
    const token = req.query.token || req.query.orderID || req.query.PayerID || null;
    if (!token) {
      if (req.flash) req.flash('error', 'Missing PayPal token');
      return res.redirect('/wallet');
    }
    const capture = await paypalService.captureOrder(token);
    const captureUnit = (capture.purchase_units && capture.purchase_units[0]) || {};
    const payments = (captureUnit.payments && captureUnit.payments.captures && captureUnit.payments.captures[0]) || {};
    const status = payments.status || capture.status || null;
    if (!status || !/COMPLET|COMPLETED/i.test(String(status))) {
      if (req.flash) req.flash('error', 'PayPal payment not completed');
      return res.redirect('/wallet');
    }

    const userId = uid(req);
    const amount = Number((payments.amount && payments.amount.value) || 0);
    // ensure wallet and update balance
    Wallet.findByUserId(userId, (err, wallet) => {
      if (err || !wallet) return res.redirect('/wallet');
      Wallet.updateBalanceByUserId(userId, amount, (uErr, updated) => {
        if (uErr) return res.redirect('/wallet');
        const walletId = (updated && updated.id) || (wallet && wallet.id) || null;
        Wallet.addTransaction({
          wallet_id: walletId,
          user_id: userId,
          type: 'TOP_UP',
          amount: amount,
          reference_type: 'paypal',
          reference_id: (payments && payments.id) || (capture.id || null),
          description: `PayPal top-up ${amount}`
        }, (tErr) => {
          if (tErr) console.error('wallet top-up tx err', tErr);
          if (req.flash) req.flash('success', 'Wallet topped up via PayPal');
          return res.redirect('/wallet');
        });
      });
    });
  } catch (ex) {
    console.error('paypalReturn error', ex);
    if (req.flash) req.flash('error', 'PayPal processing failed');
    return res.redirect('/wallet');
  }
};

// Stripe success handler for Checkout Session
exports.stripeSuccess = async (req, res, next) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) {
      if (req.flash) req.flash('error', 'Missing Stripe session id');
      return res.redirect('/wallet');
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
    const paymentIntent = session.payment_intent;
    const amount = (paymentIntent && paymentIntent.amount_received) ? (paymentIntent.amount_received / 100.0) : (session.amount_total ? (session.amount_total / 100.0) : 0);
    const userId = uid(req);
    if (!userId) return res.redirect('/login');

    Wallet.findByUserId(userId, (err, wallet) => {
      if (err || !wallet) return res.redirect('/wallet');
      Wallet.updateBalanceByUserId(userId, amount, (uErr, updated) => {
        if (uErr) return res.redirect('/wallet');
        const walletId = (updated && updated.id) || (wallet && wallet.id) || null;
        Wallet.addTransaction({
          wallet_id: walletId,
          user_id: userId,
          type: 'TOP_UP',
          amount: amount,
          reference_type: 'stripe',
          reference_id: (paymentIntent && paymentIntent.id) || (session.payment_intent || null),
          description: `Stripe top-up ${amount}`
        }, (tErr) => {
          if (tErr) console.error('wallet top-up tx err', tErr);
          if (req.flash) req.flash('success', 'Wallet topped up via Stripe');
          return res.redirect('/wallet');
        });
      });
    });
  } catch (ex) {
    console.error('stripeSuccess error', ex);
    if (req.flash) req.flash('error', 'Stripe processing failed');
    return res.redirect('/wallet');
  }
};

// Add / link a new card / payment method (very small, server-side storage only)
exports.addMethod = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  // Saving payment methods to local DB is disabled. Use tokenized flows (Stripe/PayPal/NETS) at checkout/top-up.
  if (req.flash) req.flash('error', 'Saving payment methods is disabled');
  return res.redirect('/wallet');
};

// return wallet balance as JSON for checkout modal
exports.balance = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });
  Wallet.findByUserId(userId, (err, wallet) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to load wallet' });
    const balance = (wallet && Number(wallet.balance || 0)) || 0;
    return res.json({ success: true, balance });
  });
};

// Return coupons linked to the user and active global coupons
exports.userCoupons = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated' });

  const now = new Date();
  const nowStr = now.toISOString().slice(0, 19).replace('T', ' ');

  // 1) Fetch user-specific coupons (user_coupons joined to coupons)
  const userSql = `
    SELECT uc.id AS user_coupon_id, uc.user_id, uc.coupon_id, uc.coupon_code AS user_coupon_code, uc.times_used, uc.status AS user_status, uc.assigned_at,
           c.id AS c_id, c.coupon_code AS c_coupon_code, c.description, c.discount_type, c.discount_value, c.valid_from, c.valid_until, c.is_global, c.is_active, c.min_spend, c.is_free_delivery
    FROM user_coupons uc
    JOIN coupons c ON c.id = uc.coupon_id
    WHERE uc.user_id = ?
    ORDER BY uc.assigned_at DESC
  `;

  db.query(userSql, [userId], (uErr, uRows = []) => {
    if (uErr) { console.error('userCoupons - user coupons query error', uErr); return res.status(500).json({ success: false, message: 'Failed to load user coupons' }); }

    // 2) Fetch global coupons that are active and within validity window
    const globalSql = `
      SELECT c.*, NULL AS user_coupon_id, 0 AS times_used, 'GLOBAL' AS user_status
      FROM coupons c
      WHERE c.is_global = 1 AND c.is_active = 1
        AND (c.valid_from IS NULL OR c.valid_from <= NOW()) AND (c.valid_until IS NULL OR c.valid_until >= NOW())
      ORDER BY c.created_at DESC
    `;

    db.query(globalSql, [], (gErr, gRows = []) => {
      if (gErr) { console.error('userCoupons - global coupons query error', gErr); return res.status(500).json({ success: false, message: 'Failed to load global coupons' }); }

      console.log('[WalletController.userCoupons] userId:', userId, 'userRows:', (uRows || []).length, 'globalRows:', (gRows || []).length);
      console.log('[WalletController.userCoupons] nowStr:', nowStr);
      console.log('[WalletController.userCoupons] globalCoupons raw:', (gRows || []).map(r => ({ id: r.id, code: r.coupon_code, is_global: r.is_global, is_active: r.is_active, valid_from: r.valid_from, valid_until: r.valid_until })));

      // Merge; prefer user-specific records when coupon_id overlaps
        const userCouponIds = new Set();
        const merged = [];

        (uRows || []).forEach(r => {
          const entry = Object.assign({}, r, { 
            coupon_code: r.c_coupon_code || r.user_coupon_code || r.coupon_code,
            coupon_id: r.coupon_id || r.c_id
          });
          merged.push(entry);
          if (entry.coupon_id) userCouponIds.add(Number(entry.coupon_id));
        });

        // append global coupons that are not already represented by user-specific records
        (gRows || []).forEach(r => {
          const cid = Number(r.id || r.coupon_id || 0);
          if (!userCouponIds.has(cid)) merged.push(r);
        });

          // Create normalized lists for user-specific and global coupons separately
          const normalize = (c) => ({
            user_coupon_id: c.user_coupon_id || null,
            coupon_id: c.coupon_id || c.c_id || c.id || null,
            coupon_code: c.coupon_code || c.c_coupon_code || c.user_coupon_code || null,
            description: c.description || null,
            discount_type: c.discount_type || null,
            discount_value: c.discount_value || null,
            min_spend: c.min_spend || 0,
            is_free_delivery: Number(c.is_free_delivery || 0),
            is_global: Number(c.is_global || 0),
            is_active: Number(c.is_active || 0),
            times_used: Number(c.times_used || 0),
            user_status: c.user_status || (c.status || null),
            assigned_at: c.assigned_at || c.created_at || null
          });

          const userNormalized = (uRows || []).map(normalize);
          const globalNormalized = (gRows || []).map(normalize);

          // merged for backward compatibility (available first, redeemed last)
          const normalized = merged.map(normalize);

          // Sort: available first, redeemed last
          normalized.sort((a, b) => {
            const rank = s => {
              if (!s) return 1;
              const low = String(s).toLowerCase();
              if (low === 'assigned' || low === 'active' || low === 'global') return 0;
              if (low === 'exhausted' || low === 'used' || low === 'redeemed') return 2;
              return 1;
            };
            const ra = rank(a.user_status); const rb = rank(b.user_status);
            if (ra !== rb) return ra - rb;
            const ta = a.assigned_at ? new Date(a.assigned_at) : new Date(0);
            const tb = b.assigned_at ? new Date(b.assigned_at) : new Date(0);
            return tb - ta;
          });

          return res.json({ success: true, userCoupons: userNormalized, globalCoupons: globalNormalized, coupons: normalized });
    });
  });
};

// Loyalty rewards endpoints moved to LoyaltyPointsController
// These exports are kept for backwards compatibility but delegate to the new controller
const LoyaltyPointsController = require('./LoyaltyPointsController');
exports.getRewards = LoyaltyPointsController.getRewards;
exports.redeemReward = LoyaltyPointsController.redeemReward;

// Pay for the current cart using wallet balance
exports.pay = async (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const util = require('util');
  const q = util.promisify(db.query).bind(db);
  const begin = util.promisify(db.beginTransaction).bind(db);
  const commit = util.promisify(db.commit).bind(db);
  const rollbackSafe = async (err) => {
    try { db.rollback(() => {}); } catch (e) {}
    console.error('wallet.pay error:', err);
  };

  try {
    await begin();

    // Lock or create wallet
    let wRows = await q('SELECT * FROM user_wallets WHERE user_id = ? FOR UPDATE', [userId]);
    let currentWallet = (wRows && wRows[0]) || null;
    if (!currentWallet) {
      await q('INSERT INTO user_wallets (user_id, balance, createdAt) VALUES (?, 0.00, NOW())', [userId]);
      wRows = await q('SELECT * FROM user_wallets WHERE user_id = ? FOR UPDATE', [userId]);
      currentWallet = (wRows && wRows[0]) || null;
    }

    // Load cart items
    const cartRows = (await q(`SELECT ci.id AS cart_id, ci.product_id, ci.quantity AS cart_qty, p.quantity AS stock_qty, p.price AS price FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.user_id = ? FOR UPDATE`, [userId])) || [];
    if (!cartRows.length) {
      await rollbackSafe('EMPTY_CART');
      if (req.flash) req.flash('error', 'Your cart is empty');
      return res.redirect('/cart');
    }

    const outOfStock = cartRows.find(r => Number(r.cart_qty) > Number(r.stock_qty));
    if (outOfStock) {
      await rollbackSafe('OUT_OF_STOCK');
      if (req.flash) req.flash('error', 'Not enough stock for one or more items.');
      return res.redirect('/cart');
    }

    const itemsTotal = cartRows.reduce((s, r) => s + Number(r.price || 0) * Number(r.cart_qty || 0), 0);

    // Choose address and shipping
    let addrRows = await q('SELECT id FROM delivery_addresses WHERE user_id = ? ORDER BY is_default DESC, id ASC LIMIT 1', [userId]);
    if (!addrRows || !addrRows.length) {
      await rollbackSafe('NO_ADDRESS');
      if (req.flash) req.flash('error', 'Please add a delivery address');
      return res.redirect('/cart');
    }
    const deliveryAddressId = addrRows[0].id;

    let shipRow = null;
    if (req.session?.selectedShippingMethodId) {
      const sRows = await q('SELECT id, price, method_name FROM shipping_methods WHERE id = ? AND is_active = 1 LIMIT 1', [req.session.selectedShippingMethodId]);
      if (sRows && sRows.length) shipRow = sRows[0];
    }
    if (!shipRow) {
      const fallback = await q('SELECT id, price, method_name FROM shipping_methods WHERE is_active = 1 ORDER BY id ASC LIMIT 1', []);
      shipRow = (fallback && fallback[0]) || null;
    }
    if (!shipRow) {
      await rollbackSafe('NO_SHIP_METHOD');
      if (req.flash) req.flash('error', 'No shipping method available');
      return res.redirect('/cart');
    }

    // Membership perks
    const membership = await new Promise((resolve) => Membership.getUserMembership(userId, (e, m) => resolve(m || { plan_name: 'Free', free_standard_delivery: false, free_delivery_threshold: 80, discount_threshold: 0, discount_percent: 0, priority_delivery_discount: 0 })));

    let appliedShippingFee = Number(shipRow.price || 0);
    const methodName = String(shipRow?.method_name || '').toLowerCase();
    const isStandard = methodName.includes('standard');
    const isPriority = methodName.includes('priority');
    if (isStandard && (membership.free_standard_delivery || (itemsTotal >= Number(membership.free_delivery_threshold || 0)))) appliedShippingFee = 0;
    if (isPriority && Number(membership.priority_delivery_discount || 0) > 0) appliedShippingFee = Math.max(0, appliedShippingFee - Number(membership.priority_delivery_discount || 0));

    let discountAmount = 0;
    const discThresh = Number(membership.discount_threshold || 0);
    const discPercent = Number(membership.discount_percent || 0);
    if (discPercent > 0 && itemsTotal >= discThresh) discountAmount = Number((itemsTotal * (discPercent / 100)).toFixed(2));

    // Apply coupon from session if present
    const appliedCoupon = (req.session && req.session.appliedCoupon) ? req.session.appliedCoupon : null;
    const couponDiscount = Number((appliedCoupon && Number(appliedCoupon.discount || 0)) || 0);
    const subtotal = Number(itemsTotal.toFixed(2));
    const totalAmount = Number((subtotal + appliedShippingFee - discountAmount - couponDiscount).toFixed(2));
    
    const balance = Number(currentWallet.balance || 0);
    if (balance < totalAmount) {
      await rollbackSafe('INSUFFICIENT_BALANCE');
      if (req.flash) req.flash('error', 'Insufficient wallet balance');
      return res.redirect('/cart');
    }

    // Deduct balance
    await q('UPDATE user_wallets SET balance = COALESCE(balance,0) - ?, updatedAt = NOW() WHERE user_id = ?', [totalAmount, userId]);

    // Create order with coupon tracking
    const couponIdToStore = appliedCoupon && appliedCoupon.coupon_id ? appliedCoupon.coupon_id : null;
    const couponCodeSnapshot = appliedCoupon && appliedCoupon.code ? appliedCoupon.code : null;
    const orderRes = await q('INSERT INTO orders (user_id, delivery_address_id, shipping_method_id, shipping_fee, coupon_id, coupon_code_snapshot, coupon_discount, subtotal, orderDate, totalAmount, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW())', [userId, deliveryAddressId, shipRow.id, appliedShippingFee, couponIdToStore, couponCodeSnapshot, couponDiscount, subtotal, totalAmount, 'Paid']);
    const orderId = orderRes && orderRes.insertId;

    // Insert order items
    if (cartRows.length) {
      const valuesSql = cartRows.map(() => '(?, ?, ?, ?, NOW())').join(',');
      const valuesParams = cartRows.flatMap(row => [orderId, row.product_id, Number(row.cart_qty), Number(row.price || 0)]);
      await q(`INSERT INTO order_items (order_id, product_id, quantity, price, createdAt) VALUES ${valuesSql}`, valuesParams);
    }

    // Decrement stock
    for (const row of cartRows) {
      await q('UPDATE products SET quantity = quantity - ? WHERE id = ?', [Number(row.cart_qty), row.product_id]);
    }

    // Clear cart
    await q('DELETE FROM cart_items WHERE user_id = ?', [userId]);

    // Mark user coupon as used if applicable and increment master counter
    try {
      if (appliedCoupon && appliedCoupon.user_coupon_id) {
        const rows = await q('SELECT uc.times_used, uc.first_used_at, uc.coupon_id, c.max_uses_per_user FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.id = ?', [appliedCoupon.user_coupon_id]);
        const uc = Array.isArray(rows) && rows.length ? rows[0] : null;
        const timesUsed = Number(uc?.times_used || 0) + 1;
        const maxUses = Number(uc?.max_uses_per_user || 1);
        const newStatus = (maxUses && timesUsed >= maxUses) ? 'EXHAUSTED' : 'ACTIVE';
        const firstUsed = uc?.first_used_at ? ', first_used_at = first_used_at' : ', first_used_at = NOW()';
        await q(`UPDATE user_coupons SET times_used = ?, status = ?, last_used_at = NOW()${firstUsed} WHERE id = ?`, [timesUsed, newStatus, appliedCoupon.user_coupon_id]);
        if (appliedCoupon.coupon_id) {
          try { await q('UPDATE coupons SET current_total_uses = current_total_uses + 1 WHERE id = ?', [appliedCoupon.coupon_id]); } catch (incErr) { console.error('[Wallet] increment coupons.current_total_uses error', incErr); }
        }
      } else if (appliedCoupon && appliedCoupon.coupon_id && Number(appliedCoupon.is_global || 0)) {
        try {
          await q('INSERT INTO user_coupons (user_id, coupon_id, coupon_code, assigned_at, times_used, first_used_at, last_used_at, status) VALUES (?, ?, ?, NOW(), 1, NOW(), NOW(), "ACTIVE") ON DUPLICATE KEY UPDATE times_used = times_used + 1, last_used_at = NOW()', [userId, appliedCoupon.coupon_id, (appliedCoupon.code || '')]);
          await q('UPDATE coupons SET current_total_uses = current_total_uses + 1 WHERE id = ?', [appliedCoupon.coupon_id]);
          try {
            const rows2 = await q('SELECT uc.id, uc.times_used, c.max_uses_per_user FROM user_coupons uc JOIN coupons c ON c.id = uc.coupon_id WHERE uc.user_id = ? AND uc.coupon_id = ? LIMIT 1', [userId, appliedCoupon.coupon_id]);
            const ucRow = Array.isArray(rows2) && rows2.length ? rows2[0] : null;
            if (ucRow) {
              const times = Number(ucRow.times_used || 0);
              const maxU = Number(ucRow.max_uses_per_user || 1);
              if (maxU && times >= maxU) {
                await q('UPDATE user_coupons SET status = ? WHERE id = ?', ['EXHAUSTED', ucRow.id]);
              }
            }
          } catch (stErr) { console.error('[Wallet] verify/update user_coupons status error', stErr); }
        } catch (cErr) { console.error('[Wallet] mark global coupon used error', cErr); }
      }
    } catch (e) { console.error('[Wallet] mark user_coupon used error', e); }

    // Record wallet transaction (best-effort)
    try {
      await new Promise((resolve) => Wallet.addTransaction({
        wallet_id: currentWallet.id,
        user_id: userId,
        type: 'PAYMENT',
        amount: -Math.abs(totalAmount),
        reference_type: 'order',
        reference_id: String(orderId),
        description: `Order ${orderId} paid with Wallet`
      }, (txErr) => { if (txErr) console.error('wallet tx record err', txErr); resolve(); }));
    } catch (e) { console.error('wallet tx record failure', e); }

    await commit();

    try { if (req.session) { req.session.cart = null; req.session.appliedCoupon = null; } } catch (e) {}
    if (req.flash) req.flash('success', 'Order placed and paid with Wallet');
    return res.redirect(`/payment/success?orderId=${orderId}&method=wallet&amount=${encodeURIComponent(totalAmount)}`);
  } catch (ex) {
    console.error('wallet.pay unexpected error', ex);
    try { db.rollback(() => {}); } catch (e) {}
    return next(ex);
  }
};
