require('dotenv').config();

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');

const ProductController = require('./controllers/ProductController');
const CartController = require('./controllers/CartController');
const OrderController = require('./controllers/OrderController');
const UserController = require('./controllers/UserController');
const CategoryController = require('./controllers/CategoryController');

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

  res.locals.success_msg = req.flash('success_msg');
  res.locals.error_msg = req.flash('error_msg');
  res.locals.error = req.flash('error');
  res.locals.messages = req.flash();
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
app.post('/cart/pay', requireUser, (req, res, next) => OrderController.checkout(req, res, next));
app.post('/cart/checkout', requireUser, ensure(OrderController.checkout, 'OrderController.checkout'));
app.post('/cart/clear', requireUser, CartController.clear);

// Orders
app.get('/orders/:id/receipt', requireUser, ensure(OrderController.showReceipt, 'OrderController.showReceipt'));
app.get('/orders', requireUser, ensure(OrderController.history, 'OrderController.history'));
app.post('/orders/place', (req, res, next) => {
  if (!req.session?.user && !req.session?.userId) return res.redirect('/login');
  return OrderController.placeOrder(req, res, next);
});
app.get('/orderHistory', requireUser, (req, res, next) => {
  const uid = req.session.user?.id || req.session.userId;
  db.query(
    'SELECT id, user_id AS userId, orderDate, totalAmount, status, createdAt FROM orders WHERE user_id = ? ORDER BY orderDate DESC',
    [uid],
    (err, orders) => {
      if (err) return next(err);
      res.render('orderHistory', { orders: orders || [] });
    }
  );
});

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

/* ---------- errors & server ---------- */
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Server error');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
