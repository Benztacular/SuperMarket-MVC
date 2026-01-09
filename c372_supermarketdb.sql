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
('Same Day Delivery', 'Delivered today', 10.00, 'Today'),
('Standard Shipping', 'Delivered in 3–5 days', 4.50, '3–5 days');

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
  reference_id INT,
  description VARCHAR(255),
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (wallet_id) REFERENCES user_wallets(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
