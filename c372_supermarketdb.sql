CREATE DATABASE IF NOT EXISTS c372_supermarketdb
  /*!40100 DEFAULT CHARACTER SET latin1 */ /*!80016 DEFAULT ENCRYPTION='N' */;
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
);

INSERT INTO categories (categoryName)
VALUES ('Fruits'),('Vegetables'),('Dairy'),('Bakery');

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
  FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO products VALUES
(1,'Apples',50,1.50,'apples.png',1,0,0),
(2,'Bananas',75,0.80,'bananas.png',1,0,0),
(3,'Milk',50,3.50,'milk.png',3,0,0),
(4,'Bread',80,1.80,'bread.png',4,0,0),
(14,'Tomatoes',80,1.50,'tomatoes.png',2,0,0),
(19,'Broccoli',100,5.00,'Broccoli.png',2,0,0);

-- ============================================================
-- USERS
-- ============================================================
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(20) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  address VARCHAR(255) NOT NULL,
  contact VARCHAR(10) NOT NULL,
  role VARCHAR(10) NOT NULL,
  twoFactorSecret VARCHAR(255),
  twoFactorEnabled TINYINT(1) DEFAULT 0,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  profileImage VARCHAR(255) DEFAULT 'default.png',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

INSERT INTO users VALUES
(1,'Peter Lim','peter@peter.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands Ave 2','98765432','admin',NULL,0,CURRENT_TIMESTAMP,'default.png'),
(2,'Mary Tan','mary@mary.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Tampines Ave 1','12345678','user',NULL,0,CURRENT_TIMESTAMP,'default.png'),
(3,'bobochan','bobochan@gmail.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands','98765432','user',NULL,0,CURRENT_TIMESTAMP,'default.png'),
(4,'sarahlee','sarahlee@gmail.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands','98765432','user',NULL,0,CURRENT_TIMESTAMP,'default.png');

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
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO delivery_addresses
(user_id, recipient_name, contact_number, block_number, street_name, unit_number, postal_code, is_default)
VALUES
(3,'Bobo Chan','98765432','Blk 123','Tampines Ave 1','#12-34','520123',1);

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
  is_active TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO shipping_methods
(method_name, description, price, estimated_days)
VALUES
('Priority Delivery', 'Delivered today , 1-2 Hours', 8.00, 'Today , 1-2 Hours '),
('Standard Shipping', 'Delivered today , Standard Time', 2.50, 'Today, 5-6 Hours');

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
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- ORDERS (ADDRESS + SHIPPING METHOD + SHIPPING FEE)
-- ============================================================
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  delivery_address_id INT NOT NULL,
  shipping_method_id INT NOT NULL,
  shipping_fee DECIMAL(10,2) NOT NULL,
  orderDate DATETIME DEFAULT CURRENT_TIMESTAMP,
  totalAmount DOUBLE(10,2) NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'Pending',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_address_id) REFERENCES delivery_addresses(id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  FOREIGN KEY (shipping_method_id) REFERENCES shipping_methods(id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
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
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
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
  currency VARCHAR(10),
  payment_status VARCHAR(50),
  payment_time DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- NETS QR TRANSACTIONS
-- ============================================================
DROP TABLE IF EXISTS nets_transactions;
CREATE TABLE nets_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,

  user_id INT NOT NULL,
  order_id INT NOT NULL,

  -- your internal reference (generate this before calling NETS)
  merchant_txn_ref VARCHAR(100) NOT NULL,

  -- NETS / gateway reference IDs you receive back
  nets_txn_id VARCHAR(100),
  qr_payload TEXT,                 -- optional: store generated QR payload (if any)
  
  amount DECIMAL(10,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'SGD',

  payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  -- examples: PENDING, SUCCESS, FAILED, CANCELLED, EXPIRED, REFUNDED

  payment_time DATETIME NULL,

  raw_response JSON NULL,          -- store full callback/webhook response safely
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
  id INT AUTO_INCREMENT PRIMARY KEY,   -- Unique ID for the transaction
  user_id INT NOT NULL,                 -- Foreign key for user who made the payment
  order_id INT NOT NULL,                -- Foreign key for the associated order
  stripe_txn_id VARCHAR(100) NOT NULL,  -- The payment intent ID returned by Stripe
  stripe_charge_id VARCHAR(100) NULL,   -- The charge ID returned by Stripe (from latest_charge)
  payment_status VARCHAR(50) NOT NULL,  -- Status of the payment (e.g., 'success', 'failed', 'pending')
  amount DECIMAL(10,2) NOT NULL,        -- Amount of the transaction
  currency VARCHAR(10) DEFAULT 'SGD',   -- Currency used for the transaction
  payment_time DATETIME DEFAULT CURRENT_TIMESTAMP, -- Timestamp for when the payment was processed
  raw_response JSON NULL,               -- Store raw response from Stripe (optional, for debugging)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,  -- Timestamp for when the record was created
  updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP, -- Automatically updated when the record is updated
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,    -- Foreign key referencing users table
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE   -- Foreign key referencing orders table
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Indexes for efficient querying
CREATE INDEX idx_stripe_user_id ON stripe_transactions(user_id);
CREATE INDEX idx_stripe_order_id ON stripe_transactions(order_id);
CREATE INDEX idx_stripe_txn_id ON stripe_transactions(stripe_txn_id);
CREATE INDEX idx_stripe_status ON stripe_transactions(payment_status);



-- ============================================================
-- PRODUCT REVIEWS
-- ============================================================
DROP TABLE IF EXISTS product_reviews;
CREATE TABLE product_reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  product_id INT NOT NULL,
  order_id INT NOT NULL,
  rating INT NOT NULL,
  review TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_review_per_order (user_id, product_id, order_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- USER WALLETS
-- ============================================================
DROP TABLE IF EXISTS user_wallets;
CREATE TABLE user_wallets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  balance DECIMAL(10,2) DEFAULT 0.00,
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
  FOREIGN KEY (wallet_id) REFERENCES user_wallets(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Refund Request - Add Admin Approval Feature
-- ============================================================

-- Refunds table creation
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
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- Add Indexes to Track Refund Requests for Admin Approvals
-- ============================================================
CREATE INDEX idx_refunds_status ON refunds(status);
CREATE INDEX idx_refunds_user_id ON refunds(user_id);
CREATE INDEX idx_refunds_order_id ON refunds(order_id);

-- ============================================================
-- MEMBERSHIP PLANS (with tier inheritance)
-- Free (tier 1), Standard (tier 2), FreshPlus (tier 3)
-- Higher tier includes perks from lower tiers (handled in MVC by combining tiers)
-- ============================================================

DROP TABLE IF EXISTS user_memberships;
DROP TABLE IF EXISTS membership_plans;

CREATE TABLE membership_plans (
  id INT AUTO_INCREMENT PRIMARY KEY,

  plan_name VARCHAR(50) NOT NULL,
  tier_level INT NOT NULL,                               -- 1=Free, 2=Standard, 3=FreshPlus
  billing_period ENUM('MONTHLY','YEARLY') NOT NULL,      -- MONTHLY / YEARLY

  price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  duration_days INT NULL,                                -- NULL for Free

  is_active TINYINT(1) DEFAULT 1,

  -- perks (stored per tier)
  free_standard_delivery TINYINT(1) DEFAULT 0,           -- FreshPlus: 1
  priority_delivery_discount DECIMAL(10,2) DEFAULT 0.00, -- FreshPlus: 5.00
  points_multiplier DECIMAL(5,2) DEFAULT 1.00,           -- Free:0.25, Std:1.0, FreshPlus:2.5
  free_delivery_threshold DECIMAL(10,2) DEFAULT NULL,    -- Free:80, Std:40, FreshPlus:NULL
  discount_threshold DECIMAL(10,2) DEFAULT NULL,         -- Std:0 (all orders), FreshPlus:0 (all orders)
  discount_percent DECIMAL(5,2) DEFAULT 0.00             -- Std:2, FreshPlus:5
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Insert plans (your NEW updated values + yearly prices)
INSERT INTO membership_plans
(plan_name, tier_level, billing_period, price, duration_days,
 free_standard_delivery, priority_delivery_discount, points_multiplier,
 free_delivery_threshold, discount_threshold, discount_percent)
VALUES

-- =========================
-- TIER 1: FREE
-- =========================
('Free', 1, 'MONTHLY', 0.00, NULL,
 0, 0.00, 0.25,
 80.00, NULL, 0.00),

-- =========================
-- TIER 2: STANDARD
-- Monthly: $7, Yearly: $60
-- =========================
('Standard (Monthly)', 2, 'MONTHLY', 7.00, 30,
 0, 0.00, 1.00,
 40.00, 30.00, 5.00),

('Standard (Yearly)', 2, 'YEARLY', 60.00, 365,
 0, 0.00, 1.00,
 40.00, 30.00, 5.00),

-- =========================
-- TIER 3: FRESHPLUS
-- Monthly: $15, Yearly: $120
-- =========================
('FreshPlus (Monthly)', 3, 'MONTHLY', 15.00, 30,
 1, 5.00, 2.50,
 NULL, 0.00, 15.00),

('FreshPlus (Yearly)', 3, 'YEARLY', 120.00, 365,
 1, 5.00, 2.50,
 NULL, 0.00, 15.00);


-- ============================================================
-- USER MEMBERSHIPS (one row per user)
-- ============================================================

CREATE TABLE user_memberships (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  plan_id INT NOT NULL,
  start_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  end_date DATETIME NULL,
  status ENUM('ACTIVE','EXPIRED','CANCELLED') DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES membership_plans(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Give every existing user the Free plan by default (Free is tier 1, monthly)
INSERT INTO user_memberships (user_id, plan_id, end_date, status)
SELECT u.id, mp.id, NULL, 'ACTIVE'
FROM users u
JOIN membership_plans mp ON mp.plan_name = 'Free'
LEFT JOIN user_memberships um ON um.user_id = u.id
WHERE um.user_id IS NULL;


-- ============================================================
-- LOYALTY (Points + Auto Tiering + Rewards Redemption)
-- Bronze -> Silver (>= 10,000) -> Gold (>= 50,000)
-- Points earned = order_total * points_multiplier (Free=0.25, Standard=1, FreshPlus=2.5)
-- ============================================================

DROP TABLE IF EXISTS loyalty_redemptions;
DROP TABLE IF EXISTS loyalty_rewards;
DROP TABLE IF EXISTS loyalty_points_transactions;
DROP TABLE IF EXISTS loyalty_accounts;

-- 1) Loyalty account (current balance + tier)
CREATE TABLE loyalty_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  points INT NOT NULL DEFAULT 0,
  tier ENUM('Bronze','Silver','Gold') NOT NULL DEFAULT 'Bronze',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Create loyalty account for every existing user
INSERT INTO loyalty_accounts (user_id)
SELECT id FROM users;


-- 2) Points transactions (earn/spend audit trail)
CREATE TABLE loyalty_points_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  order_id INT NULL,
  type ENUM('EARN','SPEND','ADJUSTMENT') NOT NULL,
  points INT NOT NULL, -- store positive points, use type to decide +/-
  description VARCHAR(255),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_lpt_user (user_id),
  INDEX idx_lpt_order (order_id),
  INDEX idx_lpt_type (type),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- 3) Rewards catalog (buy with points)
CREATE TABLE loyalty_rewards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(100) NOT NULL,
  description VARCHAR(255),

  reward_type ENUM('DISCOUNT','FREE_DELIVERY_VOUCHER','WALLET_CREDIT') NOT NULL,
  points_cost INT NOT NULL,

  min_spend DECIMAL(10,2) DEFAULT NULL,

  -- Discount reward fields
  discount_amount DECIMAL(10,2) DEFAULT NULL,
  discount_percent DECIMAL(5,2) DEFAULT NULL,

  -- Voucher validity (days)
  valid_days INT DEFAULT NULL,

  -- Wallet credit amount
  wallet_credit DECIMAL(10,2) DEFAULT NULL,

  is_active TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO loyalty_rewards
(title, description, reward_type, points_cost, min_spend, discount_amount, valid_days, wallet_credit)
VALUES
('$5 Off Fresh Produce','Min. spend $30','DISCOUNT',500,30.00,5.00,NULL,NULL),
('Free Delivery Voucher','Valid for 30 days','FREE_DELIVERY_VOUCHER',1200,NULL,NULL,30,NULL),
('$20 Wallet Credit','Auto-added to balance','WALLET_CREDIT',2500,NULL,NULL,NULL,20.00);


-- 4) Reward redemptions (user buys reward using points)
CREATE TABLE loyalty_redemptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  reward_id INT NOT NULL,

  status ENUM('ACTIVE','USED','EXPIRED','CANCELLED') DEFAULT 'ACTIVE',
  redeemedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  expiresAt DATETIME NULL,
  usedAt DATETIME NULL,

  -- snapshot values at redemption time
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
;


SET FOREIGN_KEY_CHECKS = 1;



