require('dotenv').config();

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const axios = require('axios');

const ProductController = require('./controllers/ProductController');
const CartController = require('./controllers/CartController');
const OrderController = require('./controllers/OrderController');
const UserController = require('./controllers/UserController');
const CategoryController = require('./controllers/CategoryController');
const PaypalController = require('./controllers/PaypalController');
const StripeController = require('./controllers/StripeController');
const ReviewController = require('./controllers/ReviewController');
const DeliveryAddressController = require('./controllers/DeliveryAddressController');
const WalletController = require('./controllers/WalletController');
const MembershipController = require('./controllers/MembershipController');
const MembershipModel = require('./models/Membership');
const LoyaltyPointsController = require('./controllers/LoyaltyPointsController');
const AdminController = require('./controllers/AdminController');
const NetsController = require('./controllers/NetsController');
const RefundController = require('./controllers/RefundController');

const db = require('./db');
const AdminModel = require('./models/Admin'); // kept for compatibility

const app = express();

/* ---------- infrastructure / middleware ---------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, 'public', 'images')),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});
const fileFilter = (_req, file, cb) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)
  ? cb(null, true)
  : cb(new Error('Only image files are allowed'));
const upload = multer({ storage, fileFilter, limits: { fileSize: 2 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'devsecret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.isAdmin = !!(req.session.user && req.session.user.role === 'admin');
  res.locals.cartCount = req.session.cartCount || 0;

  // Support session-based flash messages set directly on req.session (per your requirement)
  const takeSessionMsg = (key) => {
    if (!req.session) return null;
    const v = req.session[key];
    if (!v) return null;
    try { delete req.session[key]; } catch (e) { req.session[key] = null; }
    return Array.isArray(v) ? v : [v];
  };

  const sessSuccess = takeSessionMsg('success_msg');
  const sessError = takeSessionMsg('error_msg');

  // Normalize to arrays so views can iterate uniformly
  // Prefer session-set messages, otherwise fall back to connect-flash keys.
  if (sessSuccess) {
    res.locals.success_msg = sessSuccess;
  } else if (req.flash) {
    const sf = req.flash('success_msg') || [];
    const s = sf.length ? sf : (req.flash('success') || []);
    res.locals.success_msg = s;
  } else {
    res.locals.success_msg = [];
  }

  if (sessError) {
    res.locals.error_msg = sessError;
  } else if (req.flash) {
    const ef = req.flash('error_msg') || [];
    const e = ef.length ? ef : (req.flash('error') || []);
    res.locals.error_msg = e;
  } else {
    res.locals.error_msg = [];
  }

  // keep a raw 'error' array available for compatibility
  res.locals.error = (req.flash && req.flash('error')) || [];
  res.locals.messages = (req.flash && req.flash()) || {};

  next();
});

app.use((req, res, next) => {
  if (!res.locals.user?.id) {
    res.locals.cartCount = 0;
    return next();
  }
  const userId = res.locals.user.id;
  const attempts = [
    {
      sql: `SELECT COALESCE(SUM(ci.quantity),0) AS cnt
            FROM cart_items ci
            JOIN cart c ON ci.cart_id = c.id
            WHERE c.user_id = ?`,
      params: [userId]
    },
    { sql: 'SELECT COALESCE(SUM(quantity),0) AS cnt FROM cart_items WHERE user_id = ?', params: [userId] },
    { sql: 'SELECT COALESCE(SUM(quantity),0) AS cnt FROM cart WHERE user_id = ?', params: [userId] }
  ];
  let i = 0;
  const tryNext = () => {
    if (i >= attempts.length) return next();
    const attempt = attempts[i++];
    db.query(attempt.sql, attempt.params, (err, rows) => {
      if (err) return tryNext();
      const cnt = rows && rows[0] ? Number(rows[0].cnt || 0) : 0;
      res.locals.cartCount = Number.isNaN(cnt) ? 0 : cnt;
      next();
    });
  };
  tryNext();
});

app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.startsWith('/shopping')) {
    if (typeof req.query.q !== 'string') {
      if (Array.isArray(req.query.q) && req.query.q.length) req.query.q = String(req.query.q[0]);
      else req.query.q = '';
    }
    let cats = [];
    if (req.query.category) cats = Array.isArray(req.query.category) ? req.query.category : [req.query.category];
    else if (req.query['category[]']) cats = Array.isArray(req.query['category[]']) ? req.query['category[]'] : [req.query['category[]']];
    req.query.category = cats.map(c => String(c || '').trim()).filter(Boolean);
    req.query.selectedCategories = req.query.category;
  }
  next();
});

/* ---------- helpers ---------- */
function ensure(handler, label) {
  return (req, res, next) => {
    try {
      const maybePromise = handler(req, res, next);
      if (maybePromise?.then) maybePromise.catch(err => { console.error(label || 'handler error', err); next(err); });
    } catch (err) {
      console.error(label || 'handler error', err);
      next(err);
    }
  };
}
function requireUser(req, res, next) {
  if (req.session?.user || req.session?.userId || req.user || req.session?.passport?.user) return next();
  if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(401).json({ success: false, message: 'Not authenticated' });
  return res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).send('Forbidden');
}
const isAdmin = requireAdmin;

function registerPost(path, ...handlers) {
  const safeHandlers = handlers.map((h, idx) =>
    typeof h === 'function'
      ? h
      : (_req, _res, next) => next(new TypeError(`Non-function handler registered for ${path} (index ${idx})`))
  );
  app.post(path, ...safeHandlers);
}

/* ---------- routes ---------- */
// Public
app.get('/', (_req, res) => res.render('index'));
app.get('/shopping', ProductController.shopping);
registerPost('/shopping', UserController.shopping);

// Cart
app.get('/cart', requireUser, CartController.page);
app.post('/cart/add', requireUser, CartController.add);
app.post('/cart/update/:id', requireUser, CartController.update);
app.post('/cart/remove/:id', requireUser, CartController.remove);
app.post('/addToCart', requireUser, CartController.add);
app.post('/cart/update', requireUser, CartController.update);
app.post('/cart/remove', requireUser, CartController.remove);
app.get('/cart/pay', CartController.pay);
app.get('/cart/checkout', requireUser, CartController.checkoutPage);
app.post('/shipping/select', requireUser, ensure(CartController.selectShippingMethod, 'CartController.selectShippingMethod'));
app.post('/paypal/create-order', requireUser, ensure(PaypalController.createOrder, 'PaypalController.createOrder'));
app.post('/paypal/capture-order', requireUser, ensure(PaypalController.captureOrder, 'PaypalController.captureOrder'));

// Stripe routes
app.post('/stripe/create-payment-intent', requireUser, ensure(StripeController.createPaymentIntent, 'StripeController.createPaymentIntent'));
app.post('/stripe/confirm-payment', requireUser, ensure(StripeController.confirmPayment, 'StripeController.confirmPayment'));
// NETS QR integration
app.post('/generateNETSQR', requireUser, ensure(NetsController.createQr, 'NetsController.createQr'));
app.post('/nets-qr', requireUser, ensure(NetsController.createQr, 'NetsController.createQr'));
app.get('/nets-qr/success', ensure(NetsController.successPage, 'NetsController.successPage'));
app.get('/nets-qr/fail', ensure(NetsController.failPage, 'NetsController.failPage'));
// NETS webhook (NETS may call GET or POST with txn params)
app.post('/nets/webhook', express.json(), NetsController.webhook);
app.get('/nets/webhook', NetsController.webhook);
// Stripe webhook (expects raw body)
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res, next) => MembershipController.stripeWebhook(req, res, next));
// PayPal webhook
app.post('/webhooks/paypal', express.json(), (req, res, next) => MembershipController.paypalWebhook(req, res, next));
// Development helper to trigger webhook-like events (simulate NETS callback)
app.get('/nets/debug-trigger', NetsController.debugTrigger);
// SSE endpoint used by netsQr.ejs to receive payment status updates
app.get('/sse/payment-status/:txnRetrievalRef', ensure(NetsController.ssePollingStatus, 'NetsController.ssePollingStatus'));
app.get('/nets/query-status/:txn', NetsController.queryStatus);
app.post('/cart/pay', requireUser, (req, res, next) => OrderController.checkout(req, res, next));
app.post('/cart/checkout', requireUser, ensure(OrderController.checkout, 'OrderController.checkout'));
app.post('/cart/clear', requireUser, CartController.clear);

// Coupons: apply coupon via AJAX on checkout page
app.post('/api/coupons/apply', requireUser, ensure(OrderController.applyCoupon, 'OrderController.applyCoupon'));
app.post('/api/coupons/remove', requireUser, ensure(OrderController.removeCoupon, 'OrderController.removeCoupon'));

app.get('/api/delivery-addresses', requireUser, ensure(DeliveryAddressController.list, 'DeliveryAddressController.list'));
app.post('/delivery-addresses', requireUser, ensure(DeliveryAddressController.create, 'DeliveryAddressController.create'));
// API endpoint to create delivery addresses (returns JSON)
app.post('/api/delivery-addresses', requireUser, ensure(DeliveryAddressController.create, 'DeliveryAddressController.create'));
app.post('/delivery-addresses/select', requireUser, ensure(DeliveryAddressController.select, 'DeliveryAddressController.select'));
app.post('/delivery-addresses/:id/default', requireUser, ensure(DeliveryAddressController.setDefault, 'DeliveryAddressController.setDefault'));

// Payment success landing page
app.get('/payment/success', requireUser, ensure(OrderController.paymentSuccess, 'OrderController.paymentSuccess'));

// Orders
app.get('/orders/:id/receipt', requireUser, ensure(OrderController.showReceipt, 'OrderController.showReceipt'));
// backward-compatible route used by some templates: redirect to query-based PDF download
app.get('/orders/:id/receipt/pdf', requireUser, (req, res) => {
  return res.redirect(`/orders/${req.params.id}/receipt?download=pdf`);
});
app.get('/orders', requireUser, ensure(OrderController.history, 'OrderController.history'));
app.post('/orders/place', (req, res, next) => {
  if (!req.session?.user && !req.session?.userId) return res.redirect('/login');
  return OrderController.placeOrder(req, res, next);
});
app.get('/orderHistory', requireUser, ensure(OrderController.orderHistoryPage || OrderController.history, 'OrderController.orderHistoryPage'));

// Auth & profile
app.get('/login', ensure(UserController.loginPage, 'UserController.loginPage'));
app.get('/register', ensure(UserController.registerPage, 'UserController.registerPage'));
app.get('/logout', ensure(UserController.logout, 'UserController.logout'));
app.post('/register', ensure(UserController.register, 'UserController.register'));
app.post('/login', ensure(UserController.login, 'UserController.login'));
app.post('/2fa/verify-setup', ensure(UserController.verifySetup2fa, 'UserController.verifySetup2fa'));
app.post('/2fa/verify-login', ensure(UserController.verifyLogin2fa, 'UserController.verifyLogin2fa'));
app.get('/profile', requireUser, ensure(UserController.profilePage, 'UserController.profilePage'));
app.post('/profile', requireUser, upload.single('avatar'), ensure(UserController.updateProfile, 'UserController.updateProfile'));
app.post('/profile/password/verify', requireUser, ensure(UserController.verifyCurrentPassword, 'UserController.verifyCurrentPassword'));
app.post('/profile/password', requireUser, ensure(UserController.changePassword, 'UserController.changePassword'));
app.post('/profile/2fa/enable', requireUser, ensure(UserController.enable2fa, 'UserController.enable2fa'));
app.post('/profile/2fa/disable', requireUser, ensure(UserController.disableTwoFactor, 'UserController.disableTwoFactor'));

// Wallet
app.get('/wallet', requireUser, ensure(WalletController.page, 'WalletController.page'));
app.post('/wallet/topup', requireUser, ensure(WalletController.topUp, 'WalletController.topUp'));
app.post('/wallet/methods/add', requireUser, ensure(WalletController.addMethod, 'WalletController.addMethod'));
app.post('/wallet/stripe/setup-intent', requireUser, ensure(WalletController.createSetupIntent, 'WalletController.createSetupIntent'));
app.post('/wallet/stripe/save', requireUser, ensure(WalletController.saveStripeMethod, 'WalletController.saveStripeMethod'));
app.get('/wallet/paypal/return', requireUser, ensure(WalletController.paypalReturn, 'WalletController.paypalReturn'));
app.get('/wallet/stripe/success', requireUser, ensure(WalletController.stripeSuccess, 'WalletController.stripeSuccess'));
// API: wallet balance (for checkout modal)
app.get('/api/wallet/balance', requireUser, (req, res, next) => {
  try {
    const uid = (req.session && (req.session.userId || req.session.user && req.session.user.id)) || null;
    if (!uid) return res.status(401).json({ success: false, error: 'Not authenticated' });
    return WalletController.balance(req, res, next);
  } catch (e) { return next(e); }
});
app.get('/api/wallet/transactions', requireUser, (req, res, next) => {
  return WalletController.transactions(req, res, next);
});

// Membership page (public - shows plans; shows user's active membership if logged in)
app.get('/membership', ensure(MembershipController.membershipPage, 'MembershipController.membershipPage'));

// Membership checkout / payment
app.get('/membership/checkout', requireUser, ensure(MembershipController.checkoutPage, 'MembershipController.checkoutPage'));

// Membership API routes
app.get('/api/membership/plans', ensure(MembershipController.getPlans, 'MembershipController.getPlans'));
app.get('/api/membership/current', requireUser, ensure(MembershipController.getCurrentMembership, 'MembershipController.getCurrentMembership'));
app.post('/api/membership/upgrade', requireUser, ensure(MembershipController.upgradeMembership, 'MembershipController.upgradeMembership'));
app.post('/api/membership/cancel', requireUser, ensure(MembershipController.cancelMembership, 'MembershipController.cancelMembership'));
// Form-based cancel from profile page: schedule cancellation at end_date and redirect back to profile
app.post('/profile/membership/cancel', requireUser, (req, res, next) => {
  try {
    const userId = (req.session && (req.session.userId || (req.session.user && (req.session.user.id || req.session.user.user_id)))) || null;
    if (!userId) return res.redirect('/login');
    // Mark membership as cancelled (effective at the configured end_date). The periodic
    // expireOldMemberships job will switch the membership back to Free when end_date passes.
    MembershipModel.scheduleCancelUserMembership(userId, (err, membership) => {
      if (err) {
        try { req.session.error_msg = 'Unable to schedule membership cancellation at this time.'; } catch (e) {}
        return res.redirect('/profile#membership');
      }
      try {
        // Keep user's session membership value unchanged until the period ends
        req.session.success_msg = 'Cancellation scheduled: your membership will remain active until the period end.';
      } catch (e) {}
      return res.redirect('/profile#membership');
    });
  } catch (e) { return next(e); }
});
// Membership payment routes
app.post('/membership/pay/paypal', requireUser, ensure(MembershipController.payWithPaypal, 'MembershipController.payWithPaypal'));
app.get('/membership/paypal/return', requireUser, ensure(MembershipController.paypalReturn, 'MembershipController.paypalReturn'));
app.post('/membership/pay/stripe', requireUser, ensure(MembershipController.payWithStripe, 'MembershipController.payWithStripe'));
app.get('/membership/stripe/success', requireUser, ensure(MembershipController.stripeSuccess, 'MembershipController.stripeSuccess'));
app.post('/membership/pay/nets', requireUser, ensure(MembershipController.payWithNets, 'MembershipController.payWithNets'));

// Loyalty API routes
app.get('/api/loyalty/account', requireUser, ensure(LoyaltyPointsController.getAccount, 'LoyaltyPointsController.getAccount'));
app.get('/api/loyalty/rewards', requireUser, ensure(LoyaltyPointsController.getRewards, 'LoyaltyPointsController.getRewards'));
app.post('/api/loyalty/redeem', requireUser, ensure(LoyaltyPointsController.redeemReward, 'LoyaltyPointsController.redeemReward'));
app.get('/api/loyalty/redemptions', requireUser, ensure(LoyaltyPointsController.getUserRedemptions, 'LoyaltyPointsController.getUserRedemptions'));

app.post('/cart/pay/wallet', requireUser, ensure(WalletController.pay, 'WalletController.pay'));

// Refunds (User)
app.get('/orders/:orderId/refund', requireUser, ensure(RefundController.requestPage, 'RefundController.requestPage'));
app.post('/orders/:orderId/refund', requireUser, upload.single('reasonImage'), ensure(RefundController.submitRequest, 'RefundController.submitRequest'));
app.get('/user/refunds', requireUser, ensure(RefundController.userRefundHistory, 'RefundController.userRefundHistory'));

// Refunds (Admin)
app.get('/admin/refunds', requireAdmin, ensure(RefundController.adminListRefunds, 'RefundController.adminListRefunds'));
app.get('/admin/refunds/:id', requireAdmin, ensure(RefundController.adminViewRefund, 'RefundController.adminViewRefund'));
app.post('/admin/refunds/:id/approve', requireAdmin, ensure(RefundController.adminApproveRefund, 'RefundController.adminApproveRefund'));
app.post('/admin/refunds/:id/deny', requireAdmin, ensure(RefundController.adminDenyRefund, 'RefundController.adminDenyRefund'));

// Products (admin)
app.get('/admin/products', requireAdmin, (req, res, next) => {
  const handler = ProductController.adminInventoryPage || ProductController.adminProductsPage || ProductController.list || ProductController.index;
  if (typeof handler === 'function') return handler(req, res, next);
  db.query(
    `SELECT p.id, p.productName, p.quantity, p.price, p.image, p.category_id, c.categoryName
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     ORDER BY p.id ASC`,
    (err, rows) => {
      if (err) return next(err);
      res.render('inventory', { products: rows || [] });
    }
  );
});
app.get('/admin/products/add', requireAdmin, (req, res, next) => {
  const handler = ProductController.adminAddPage;
  if (typeof handler === 'function') return handler(req, res, next);
  db.query('SELECT id, categoryName FROM categories', (err, rows) => {
    if (err) return next(err);
    res.render('addProduct', { categories: rows || [] });
  });
});
app.post('/admin/products/add', requireAdmin, upload.single('image'), ensure(ProductController.adminCreate, 'ProductController.adminCreate'));
app.get('/admin/products/new', requireAdmin, (_req, res) => res.redirect('/admin/products/add'));
app.get('/admin/inventory', requireAdmin, ensure(ProductController.adminInventoryPage, 'ProductController.adminInventoryPage'));
app.get('/admin/products/new', requireAdmin, (req, res, next) => {
  const handler = ProductController.adminAddPage;
  if (typeof handler === 'function') return handler(req, res, next);
  db.query('SELECT id, categoryName FROM categories', (err, rows) => {
    if (err) return next(err);
    res.render('addProduct', { categories: rows || [] });
  });
});
app.post('/admin/products', requireAdmin, (req, res, next) => {
  const handler = ProductController.adminCreateProduct || ProductController.createProduct || ProductController.addProduct;
  if (typeof handler === 'function') return handler(req, res, next);
  const { productName, quantity, price, category_id } = req.body || {};
  db.query(
    'INSERT INTO products (productName, quantity, price, category_id, image) VALUES (?, ?, ?, ?, ?)',
    [productName || '', Number(quantity || 0), Number(price || 0), category_id || null, 'default.png'],
    (err) => {
      if (err) return next(err);
      res.redirect('/admin/products');
    }
  );
});
app.get('/admin/products/:id/edit', requireAdmin, ensure(ProductController.adminEditPage, 'ProductController.adminEditPage'));
app.post('/admin/products/:id/edit', requireAdmin, upload.single('image'), ensure(ProductController.adminUpdate, 'ProductController.adminUpdate'));
app.post('/admin/products/:id/delete', requireAdmin, ensure(ProductController.adminDelete, 'ProductController.adminDelete'));

app.get('/addProduct', requireAdmin, (_req, res) => res.redirect('/admin/products/new'));
app.get('/addproduct', requireAdmin, (_req, res) => res.redirect('/admin/products/new'));
app.post('/addProduct', requireAdmin, ensure(ProductController.adminCreate, 'ProductController.adminCreate'));
app.post('/addproduct', requireAdmin, ensure(ProductController.adminCreate, 'ProductController.adminCreate'));

// Categories API
app.get('/api/categories', CategoryController.apiList);
app.get('/admin/api/categories', requireAdmin, CategoryController.adminList);
app.post('/admin/api/categories', requireAdmin, express.json(), CategoryController.create);
app.put('/admin/api/categories/:id', requireAdmin, express.json(), CategoryController.update);
app.delete('/admin/api/categories/:id', requireAdmin, CategoryController.remove);

// Admin users
// Admin landing/dashboard
app.get('/admin', requireAdmin, ensure(AdminController.dashboard, 'AdminController.dashboard'));

app.get('/admin/users', requireAdmin, ensure(UserController.adminUsersPage, 'UserController.adminUsersPage'));
app.get('/admin/users/:id/edit', requireAdmin, ensure(UserController.adminEditUserPage, 'UserController.adminEditUserPage'));
app.post('/admin/users/:id/edit', requireAdmin, ensure(UserController.adminUpdateUser, 'UserController.adminUpdateUser'));
app.post('/admin/users/:id/delete', requireAdmin, ensure(UserController.adminDeleteUser, 'UserController.adminDeleteUser'));

// Admin orders
app.get('/admin/orders', requireAdmin, ensure(OrderController.adminList, 'OrderController.adminList'));
app.post('/admin/orders/:id/status', isAdmin, express.urlencoded({ extended: false }), OrderController.adminUpdateOrderStatus);
app.get('/admin/orders/:id', requireAdmin, ensure(OrderController.adminDetails, 'OrderController.adminDetails'));

// Product details
app.get('/product/:id', ProductController.show);
app.post('/product/:id/review', ensure(ReviewController.post, 'ReviewController.post'));

// Order-level review page (review items in a specific order)
app.get('/orders/:id/review', requireUser, ensure(ReviewController.orderReviewPage, 'ReviewController.orderReviewPage'));
app.post('/orders/:id/review/:productId', requireUser, ensure(ReviewController.saveForOrder, 'ReviewController.saveForOrder'));

// Error pages
app.get('/401', (req, res) => {
  res.render('401', { errors: req.flash('error') });
});

/* ---------- errors & server ---------- */

// Periodic job: expire old memberships (runs every minute)
try {
  (function scheduleMembershipExpiry(){
    const runExpiry = () => {
      try {
        MembershipModel.expireOldMemberships((err, result) => {
          if (err) return console.error('expireOldMemberships error', err);
          try { if (result && result.affectedRows) console.log('Expired memberships reverted:', result.affectedRows); } catch(e){}
        });
      } catch (e) { console.error('expireOldMemberships run failed', e); }
    };
    // run now
    runExpiry();
    // schedule every minute
    setInterval(runExpiry, 60 * 1000);
  })();
} catch (e) { console.error('Failed to schedule membership expiry job', e); }

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Server error');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
