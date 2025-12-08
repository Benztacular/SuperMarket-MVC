CREATE DATABASE IF NOT EXISTS c372_supermarketdb
  /*!40100 DEFAULT CHARACTER SET latin1 */ /*!80016 DEFAULT ENCRYPTION='N' */;
USE c372_supermarketdb;

SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- MySQL dump set variables (fixed NULL issue)
-- ============================================================
SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT;
SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS;
SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION;
SET NAMES utf8;
SET @OLD_TIME_ZONE=@@TIME_ZONE;
SET TIME_ZONE='+00:00';
SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS;
SET UNIQUE_CHECKS=0;
SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS=0;
SET @OLD_SQL_MODE=@@SQL_MODE;
SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';
SET @OLD_SQL_NOTES=@@SQL_NOTES;
SET SQL_NOTES=0;

-- ============================================================
-- CREATE TABLES IN CORRECT ORDER
-- ============================================================

-- Categories (you added this first)
DROP TABLE IF EXISTS categories;
CREATE TABLE categories (
    id INT NOT NULL AUTO_INCREMENT,
    categoryName VARCHAR(100) NOT NULL,
    PRIMARY KEY (id)
);

LOCK TABLES categories WRITE;
INSERT INTO categories (categoryName) VALUES
('Fruits'),
('Vegetables'),
('Dairy'),
('Bakery');
UNLOCK TABLES;


-- Products
DROP TABLE IF EXISTS products;
CREATE TABLE products (
  id INT NOT NULL AUTO_INCREMENT,
  productName VARCHAR(200) COLLATE utf8mb4_general_ci NOT NULL,
  quantity INT NOT NULL,
  price DOUBLE(10,2) NOT NULL,
  image VARCHAR(50) COLLATE utf8mb4_general_ci NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Now add the category FK (previously caused error)
ALTER TABLE products
ADD COLUMN category_id INT NULL,
ADD FOREIGN KEY (category_id) REFERENCES categories(id);

-- Insert product data
LOCK TABLES products WRITE;
INSERT INTO products VALUES
(1,'Apples',50,1.50,'apples.png',1),
(2,'Bananas',75,0.80,'bananas.png',1),
(3,'Milk',50,3.50,'milk.png',3),
(4,'Bread',80,1.80,'bread.png',4),
(14,'Tomatoes',80,1.50,'tomatoes.png',2),
(19,'Broccoli',100,5.00,'Broccoli.png',2);
UNLOCK TABLES;

-- ============================================================
-- USERS TABLE (your updated version with 2FA + profileImage)
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

  twoFactorSecret VARCHAR(255) NULL,
  twoFactorEnabled TINYINT(1) NOT NULL DEFAULT 0,

  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  profileImage VARCHAR(255) NULL DEFAULT 'default.png',

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

-- Insert users
LOCK TABLES users WRITE;
INSERT INTO users
(id, username, email, password, address, contact, role, twoFactorSecret, twoFactorEnabled, createdAt, profileImage)
VALUES
(1,'Peter Lim','peter@peter.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands Ave 2','98765432','admin',NULL,0,CURRENT_TIMESTAMP,'default.png'),
(2,'Mary Tan','mary@mary.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Tampines Ave 1','12345678','user',NULL,0,CURRENT_TIMESTAMP,'default.png'),
(3,'bobochan','bobochan@gmail.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands','98765432','user',NULL,0,CURRENT_TIMESTAMP,'default.png'),
(4,'sarahlee','sarahlee@gmail.com','7c4a8d09ca3762af61e59520943dc26494f8941b','Woodlands','98765432','user',NULL,0,CURRENT_TIMESTAMP,'default.png');
UNLOCK TABLES;

-- ============================================================
-- CART ITEMS (unchanged functionality)
-- ============================================================
DROP TABLE IF EXISTS cart_items;
CREATE TABLE cart_items (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ============================================================
-- ORDERS (with status column you added)
-- ============================================================
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  orderDate DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  totalAmount DOUBLE(10,2) NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ============================================================
-- ORDER ITEMS (unchanged)
-- ============================================================
DROP TABLE IF EXISTS order_items;
CREATE TABLE order_items (
  id INT NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  price DOUBLE(10,2) NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ============================================================
-- RESTORE MYSQL DUMP VARIABLES
-- ============================================================
SET TIME_ZONE=@OLD_TIME_ZONE;
SET SQL_MODE=@OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;
SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;
SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT;
SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS;
SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION;
SET SQL_NOTES=@OLD_SQL_NOTES;
SET FOREIGN_KEY_CHECKS = 1;