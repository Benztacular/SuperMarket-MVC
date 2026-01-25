CREATE DATABASE IF NOT EXISTS c372_supermarketdb
  /*!40100 DEFAULT CHARACTER SET utf8mb4 */ /*!80016 DEFAULT ENCRYPTION='N' */;
USE c372_supermarketdb;

SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- CATEGORIES
-- ============================================================
DROP TABLE IF EXISTS categories;
CREATE TABLE categories (
  id INT NOT NULL AUTO_INCREMENT,
  categoryName VARCHAR(100) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO categories (categoryName)
VALUES ('Fruits'), ('Vegetables'), ('Dairy'), ('Bakery');

-- ============================================================
-- PRODUCTS
-- ============================================================
DROP TABLE IF EXISTS products;
CREATE TABLE products (
  id INT NOT NULL AUTO_INCREMENT,
  productName VARCHAR(200) NOT NULL,
  quantity INT NOT NULL,
  price DOUBLE(10,2) NOT NULL,
  image VARCHAR(50) NOT NULL,
  category_id INT NULL,
  averageRating DECIMAL(3,2) DEFAULT 0.00,
  reviewCount INT DEFAULT 0,
  PRIMARY KEY (id),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO products VALUES
(1, 'Apples', 50, 1.50, 'apples.png', 1, 0, 0),
(2, 'Bananas', 75, 0.80, 'bananas.png', 1, 0, 0),
(3, 'Milk', 50, 3.50, 'milk.png', 3, 0, 0),
(4, 'Bread', 80, 1.80, 'bread.png', 4, 0, 0),
(14, 'Tomatoes', 80, 1.50, 'tomatoes.png', 2, 0, 0),
(19, 'Broccoli', 100, 5.00, 'Broccoli.png', 2, 0, 0);

-- ============================================================
-- USERS
-- ============================================================
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(20) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  address VARCHAR(255) NOT NULL,
  contact VARCHAR(10) NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'user',
  twoFactorSecret VARCHAR(255),
  twoFactorEnabled TINYINT(1) DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  profileImage VARCHAR(255) DEFAULT 'default.png',
  PRIMARY KEY (id),
  INDEX idx_email (email),
  INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO users VALUES
(1, 'Peter Lim', 'peter@peter.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Woodlands Ave 2', '98765432', 'admin', NULL, 0, CURRENT_TIMESTAMP, 'default.png'),
(2, 'Mary Tan', 'mary@mary.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Tampines Ave 1', '12345678', 'user', NULL, 0, CURRENT_TIMESTAMP, 'default.png'),
(3, 'bobochan', 'bobochan@gmail.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Woodlands', '98765432', 'user', NULL, 0, CURRENT_TIMESTAMP, 'default.png'),
(4, 'sarahlee', 'sarahlee@gmail.com', '7c4a8d09ca3762af61e59520943dc26494f8941b', 'Woodlands', '98765432', 'user', NULL, 0, CURRENT_TIMESTAMP, 'default.png');

-- ============================================================
-- DELIVERY ADDRESSES
-- ============================================================
DROP TABLE IF EXISTS delivery_addresses;
CREATE TABLE delivery_addresses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  recipient_name VARCHAR(100) NOT NULL,
  contact_number VARCHAR(20) NOT NULL,
  block_number VARCHAR(20) NOT NULL,
  street_name VARCHAR(255) NOT NULL,
  unit_number VARCHAR(20) NOT NULL,
  postal_code VARCHAR(20) NOT NULL,
  country VARCHAR(100) DEFAULT 'Singapore',
  is_default TINYINT(1) DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_is_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO delivery_addresses (user_id, recipient_name, contact_number, block_number, street_name, unit_number, postal_code, is_default)
VALUES
(3, 'Bobo Chan', '98765432', 'Blk 123', 'Tampines Ave 1', '#12-34', '520123', 1);

-- ============================================================
-- SHIPPING METHODS
-- ============================================================
DROP TABLE IF EXISTS shipping_methods;
CREATE TABLE shipping_methods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  method_name VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  price DECIMAL(10,2) NOT NULL,
  estimated_days VARCHAR(50),
  is_active TINYINT(1) DEFAULT 1,
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO shipping_methods (method_name, description, price, estimated_days)
VALUES
('Priority Delivery', 'Delivered today, 1-2 Hours', 8.00, 'Today, 1-2 Hours'),
('Standard Shipping', 'Delivered today, Standard Time', 2.50, 'Today, 5-6 Hours');

-- ============================================================
-- CART ITEMS
-- ============================================================
DROP TABLE IF EXISTS cart_items;
CREATE TABLE cart_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_product (user_id, product_id),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- COUPONS TABLE
-- Global coupons: is_global=1, each user can use once (tracked in user_coupons)
-- User-specific coupons: is_global=0, assigned to specific users only
-- ============================================================
DROP TABLE IF EXISTS coupons;
CREATE TABLE coupons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  coupon_code VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL,
  discount_type ENUM('PERCENTAGE', 'FIXED') NOT NULL,
  discount_value DECIMAL(10,2) NOT NULL,
  valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
  valid_until DATETIME,
  is_global TINYINT(1) DEFAULT 0,  -- 1 = available to all users (once per user), 0 = user-specific
  is_active TINYINT(1) DEFAULT 1,  -- 1 = available, 0 = deactivated
  min_spend DECIMAL(10,2) DEFAULT 0.00,
  max_uses_per_user INT DEFAULT 1,  -- How many times each user can use this coupon
  total_usage_limit INT DEFAULT NULL,  -- NULL = unlimited total uses, otherwise max total redemptions
  current_total_uses INT DEFAULT 0,  -- Track total uses across all users
  is_free_delivery TINYINT(1) DEFAULT 0,  -- 1 = free delivery voucher, 0 = regular discount
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_coupon_code (coupon_code),
  INDEX idx_is_active (is_active),
  INDEX idx_is_global (is_global)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Global coupons that any user can use once
INSERT INTO coupons (coupon_code, description, discount_type, discount_value, valid_until, is_global, min_spend, max_uses_per_user, total_usage_limit)
VALUES
('FRESH10', '10% Off on Fresh Produce', 'PERCENTAGE', 10.00, '2026-12-31', 1, 50.00, 1, NULL),  -- Unlimited total uses, 1 per user
('FIVE_OFF', '$5 Off on Orders Above $30', 'FIXED', 5.00, '2026-12-31', 1, 30.00, 1, 100);  -- Max 100 total uses, 1 per user

-- ============================================================
-- USER COUPONS TABLE
-- Tracks which users have used which coupons and how many times
-- For global coupons: creates a record when user first uses it
-- For user-specific coupons: assigned by admin/system
-- ============================================================
DROP TABLE IF EXISTS user_coupons;
CREATE TABLE user_coupons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  coupon_id INT NOT NULL,
  coupon_code VARCHAR(50) NOT NULL,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  times_used INT DEFAULT 0,  -- How many times this user has used this coupon
  first_used_at DATETIME NULL,  -- When user first used the coupon
  last_used_at DATETIME NULL,  -- When user last used the coupon
  status ENUM('ASSIGNED', 'ACTIVE', 'EXHAUSTED', 'EXPIRED') DEFAULT 'ASSIGNED',
  -- ASSIGNED = given to user but not used yet
  -- ACTIVE = user has used it but can use again (if max_uses_per_user > 1)
  -- EXHAUSTED = user has reached max_uses_per_user
  -- EXPIRED = coupon validity period has passed
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_coupon (user_id, coupon_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_coupon_id (coupon_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pre-assign specific coupons to users (optional - for user-specific coupons)
INSERT INTO user_coupons (user_id, coupon_id, coupon_code, status)
VALUES
(1, 1, 'FRESH10', 'ASSIGNED'),
(2, 2, 'FIVE_OFF', 'ASSIGNED');

-- ============================================================
-- ORDERS
-- ============================================================
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  delivery_address_id INT NOT NULL,
  shipping_method_id INT NOT NULL,
  shipping_fee DECIMAL(10,2) NOT NULL,
  coupon_id INT NULL,
  coupon_code_snapshot VARCHAR(50) NULL,
  coupon_discount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  totalAmount DECIMAL(10,2) NOT NULL,
  orderDate DATETIME DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'Pending',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_address_id) REFERENCES delivery_addresses(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (shipping_method_id) REFERENCES shipping_methods(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_order_date (orderDate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- ORDER ITEMS
-- ============================================================
DROP TABLE IF EXISTS order_items;
CREATE TABLE order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  price DOUBLE(10,2) NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_order_id (order_id),
  INDEX idx_product_id (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- PAYPAL TRANSACTIONS
-- ============================================================
DROP TABLE IF EXISTS paypal_transactions;
CREATE TABLE paypal_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  order_id INT NOT NULL,
  paypal_order_id VARCHAR(100) NOT NULL,
  paypal_capture_id VARCHAR(100),
  payer_email VARCHAR(255),
  amount DECIMAL(10,2),
  currency VARCHAR(10) DEFAULT 'SGD',
  payment_status VARCHAR(50),
  payment_time DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_paypal_order_id (paypal_order_id),
  INDEX idx_user_id (user_id),
  INDEX idx_order_id (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- NETS QR TRANSACTIONS
-- ============================================================
DROP TABLE IF EXISTS nets_transactions;
CREATE TABLE nets_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  order_id INT NOT NULL,
  merchant_txn_ref VARCHAR(100) NOT NULL,
  nets_txn_id VARCHAR(100),
  qr_payload TEXT,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'SGD',
  payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  payment_time DATETIME NULL,
  raw_response JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_merchant_txn_ref (merchant_txn_ref),
  INDEX idx_user_id (user_id),
  INDEX idx_order_id (order_id),
  INDEX idx_status (payment_status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- STRIPE TRANSACTIONS
-- ============================================================
DROP TABLE IF EXISTS stripe_transactions;
CREATE TABLE stripe_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  order_id INT NOT NULL,
  stripe_txn_id VARCHAR(100) NOT NULL,
  stripe_charge_id VARCHAR(100) NULL,
  payment_status VARCHAR(50) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'SGD',
  payment_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  raw_response JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_stripe_user_id (user_id),
  INDEX idx_stripe_order_id (order_id),
  INDEX idx_stripe_txn_id (stripe_txn_id),
  INDEX idx_stripe_status (payment_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- PRODUCT REVIEWS
-- ============================================================
DROP TABLE IF EXISTS product_reviews;
CREATE TABLE product_reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  product_id INT NOT NULL,
  order_id INT NOT NULL,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_review_per_order (user_id, product_id, order_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  INDEX idx_product_id (product_id),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- USER WALLETS
-- ============================================================
DROP TABLE IF EXISTS user_wallets;
CREATE TABLE user_wallets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  balance DECIMAL(10,2) DEFAULT 0.00 CHECK (balance >= 0),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO user_wallets (user_id)
SELECT id FROM users;

-- ============================================================
-- WALLET TRANSACTIONS
-- ============================================================
DROP TABLE IF EXISTS wallet_transactions;
CREATE TABLE wallet_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  wallet_id INT NOT NULL,
  user_id INT NOT NULL,
  type ENUM('TOP_UP','PAYMENT','REFUND','ADJUSTMENT') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  reference_type VARCHAR(50),
  reference_id VARCHAR(255),
  description VARCHAR(255),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (wallet_id) REFERENCES user_wallets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_wallet_id (wallet_id),
  INDEX idx_user_id (user_id),
  INDEX idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- REFUNDS
-- ============================================================
DROP TABLE IF EXISTS refunds;
CREATE TABLE refunds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  user_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'SGD',
  method VARCHAR(50),
  gateway_ref VARCHAR(100),
  status ENUM('PENDING', 'APPROVED', 'DENIED', 'PROCESSING', 'SUCCESS', 'FAILED') DEFAULT 'PENDING',
  reason TEXT,
  reasonImage VARCHAR(255),
  admin_note TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_refunds_status (status),
  INDEX idx_refunds_user_id (user_id),
  INDEX idx_refunds_order_id (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- MEMBERSHIP PLANS
-- ============================================================
DROP TABLE IF EXISTS membership_plans;
CREATE TABLE membership_plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_name VARCHAR(50) NOT NULL,
  tier_level INT NOT NULL,
  billing_period ENUM('MONTHLY','ANNUALLY') NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  duration_days INT NULL,
  is_active TINYINT(1) DEFAULT 1,
  free_standard_delivery TINYINT(1) DEFAULT 0,
  priority_delivery_discount DECIMAL(10,2) DEFAULT 0.00,
  points_multiplier DECIMAL(5,2) DEFAULT 1.00,
  free_delivery_threshold DECIMAL(10,2) DEFAULT NULL,
  discount_threshold DECIMAL(10,2) DEFAULT NULL,
  discount_percent DECIMAL(5,2) DEFAULT 0.00,
  INDEX idx_tier_level (tier_level),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO membership_plans
(plan_name, tier_level, billing_period, price, duration_days,
 free_standard_delivery, priority_delivery_discount, points_multiplier,
 free_delivery_threshold, discount_threshold, discount_percent)
VALUES
('Free', 1, 'MONTHLY', 0.00, NULL, 0, 0.00, 0.25, 80.00, NULL, 0.00),
('Standard (Monthly)', 2, 'MONTHLY', 7.00, 30, 0, 0.00, 1.00, 40.00, 30.00, 5.00),
('Standard (Annually)', 2, 'ANNUALLY', 70.00, 365, 0, 0.00, 1.00, 40.00, 30.00, 5.00),
('FreshPlus (Monthly)', 3, 'MONTHLY', 15.00, 30, 1, 5.00, 2.50, NULL, 0.00, 15.00),
('FreshPlus (Annually)', 3, 'ANNUALLY', 150.00, 365, 1, 5.00, 2.50, NULL, 0.00, 15.00);

-- ============================================================
-- USER MEMBERSHIPS
-- ============================================================
DROP TABLE IF EXISTS user_memberships;
CREATE TABLE user_memberships (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  plan_id INT NOT NULL,
  provider VARCHAR(20) DEFAULT 'system',
  provider_subscription_id VARCHAR(255) NULL,
  amount DECIMAL(10,2) DEFAULT NULL,
  period ENUM('MONTHLY','ANNUALLY') DEFAULT NULL,
  start_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  end_date DATETIME NULL,
  status ENUM('FREE','MEMBERSHIP_ACTIVE','ACTIVE','EXPIRED','CANCELLED') DEFAULT 'FREE',
  raw_response JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES membership_plans(id) ON DELETE RESTRICT,
  INDEX idx_provider_sub_id (provider_subscription_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO user_memberships (user_id, plan_id, provider, provider_subscription_id, amount, period, end_date, status)
SELECT u.id, mp.id, 'system', NULL, mp.price, mp.billing_period, NULL, 'FREE'
FROM users u
JOIN membership_plans mp ON mp.plan_name = 'Free'
LEFT JOIN user_memberships um ON um.user_id = u.id
WHERE um.user_id IS NULL;

-- ============================================================
-- LOYALTY ACCOUNTS
-- ============================================================
DROP TABLE IF EXISTS loyalty_accounts;
CREATE TABLE loyalty_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  points INT NOT NULL DEFAULT 0 CHECK (points >= 0),
  tier ENUM('Bronze','Silver','Gold') NOT NULL DEFAULT 'Bronze',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_tier (tier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO loyalty_accounts (user_id)
SELECT id FROM users;

-- ============================================================
-- LOYALTY POINTS TRANSACTIONS
-- ============================================================
DROP TABLE IF EXISTS loyalty_points_transactions;
CREATE TABLE loyalty_points_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  order_id INT NULL,
  type ENUM('EARN','SPEND','ADJUSTMENT') NOT NULL,
  points INT NOT NULL,
  description VARCHAR(255),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lpt_user (user_id),
  INDEX idx_lpt_order (order_id),
  INDEX idx_lpt_type (type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- LOYALTY REWARDS
-- ============================================================
DROP TABLE IF EXISTS loyalty_rewards;
CREATE TABLE loyalty_rewards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  reward_type ENUM('DISCOUNT','FREE_DELIVERY_VOUCHER','WALLET_CREDIT') NOT NULL,
  points_cost INT NOT NULL,
  min_spend DECIMAL(10,2) DEFAULT NULL,
  discount_amount DECIMAL(10,2) DEFAULT NULL,
  discount_percent DECIMAL(5,2) DEFAULT NULL,
  valid_days INT DEFAULT NULL,
  wallet_credit DECIMAL(10,2) DEFAULT NULL,
  is_active TINYINT(1) DEFAULT 1,
  INDEX idx_is_active (is_active),
  INDEX idx_reward_type (reward_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO loyalty_rewards
(title, description, reward_type, points_cost, min_spend, discount_amount, valid_days, wallet_credit)
VALUES
('$5 Off Fresh Produce', 'Min. spend $30', 'DISCOUNT', 500, 30.00, 5.00, NULL, NULL),
('Free Delivery Voucher', 'Valid for 30 days', 'FREE_DELIVERY_VOUCHER', 1200, NULL, NULL, 30, NULL),
('$20 Wallet Credit', 'Auto-added to balance', 'WALLET_CREDIT', 2500, NULL, NULL, NULL, 20.00);

-- ============================================================
-- LOYALTY REDEMPTIONS
-- ============================================================
DROP TABLE IF EXISTS loyalty_redemptions;
CREATE TABLE loyalty_redemptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  reward_id INT NOT NULL,
  status ENUM('ACTIVE','USED','EXPIRED','CANCELLED') DEFAULT 'ACTIVE',
  redeemedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  expiresAt DATETIME NULL,
  usedAt DATETIME NULL,
  points_cost INT NOT NULL,
  reward_type ENUM('DISCOUNT','FREE_DELIVERY_VOUCHER','WALLET_CREDIT') NOT NULL,
  discount_amount DECIMAL(10,2) DEFAULT NULL,
  discount_percent DECIMAL(5,2) DEFAULT NULL,
  min_spend DECIMAL(10,2) DEFAULT NULL,
  wallet_credit DECIMAL(10,2) DEFAULT NULL,
  INDEX idx_lr_user (user_id),
  INDEX idx_lr_status (status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reward_id) REFERENCES loyalty_rewards(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;