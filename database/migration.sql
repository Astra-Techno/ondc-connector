-- ============================================================
-- ONDC Connector — Complete Database Migration
-- Run this ONCE on your MySQL database before starting server
-- Safe to run: uses IF NOT EXISTS + duplicate guards
-- ============================================================

-- Use your database
-- USE ondc_connector;

-- ============================================================
-- HELPER PROCEDURE — safely add a column if it doesn't exist
-- ============================================================
DROP PROCEDURE IF EXISTS AddColIfNotExists;
DELIMITER //
CREATE PROCEDURE AddColIfNotExists(
  IN tbl  VARCHAR(64),
  IN col  VARCHAR(64),
  IN def  TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE table_schema = DATABASE()
      AND table_name   = tbl
      AND column_name  = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- ============================================================
-- TABLE: tenants
-- ============================================================
CREATE TABLE IF NOT EXISTS `tenants` (
  `id`         INT(11)      NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200) NOT NULL,
  `slug`       VARCHAR(100) NOT NULL UNIQUE,
  `email`      VARCHAR(200) DEFAULT NULL,
  `phone`      VARCHAR(20)  DEFAULT NULL,
  `status`     ENUM('active','inactive','suspended') DEFAULT 'active',
  `role`       VARCHAR(50)  DEFAULT 'tenant',
  `created_at` DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: api_keys
-- ============================================================
CREATE TABLE IF NOT EXISTS `api_keys` (
  `id`         INT(11)      NOT NULL AUTO_INCREMENT,
  `tenant_id`  INT(11)      NOT NULL,
  `key_value`  VARCHAR(100) NOT NULL UNIQUE,
  `name`       VARCHAR(100) DEFAULT 'Default',
  `is_active`  TINYINT(1)   DEFAULT 1,
  `last_used`  DATETIME     DEFAULT NULL,
  `created_at` DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_key_value` (`key_value`),
  CONSTRAINT `fk_apikeys_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: tenant_ondc_config
-- ============================================================
CREATE TABLE IF NOT EXISTS `tenant_ondc_config` (
  `id`                  INT(11)      NOT NULL AUTO_INCREMENT,
  `tenant_id`           INT(11)      NOT NULL,
  `subscriber_id`       VARCHAR(200) NOT NULL,
  `subscriber_url`      VARCHAR(500) NOT NULL,
  `ondc_env`            ENUM('preprod','prod') DEFAULT 'preprod',
  `signing_private_key` TEXT         DEFAULT NULL,
  `signing_public_key`  TEXT         DEFAULT NULL,
  `unique_key_id`       VARCHAR(100) DEFAULT NULL,
  `key_valid_until`     DATETIME     DEFAULT NULL,
  `registry_url`        VARCHAR(500) DEFAULT 'https://preprod.registry.ondc.org/ondc/subscriber',
  `gateway_url`         VARCHAR(500) DEFAULT 'https://preprod.gateway.ondc.org',
  `is_active`           TINYINT(1)   DEFAULT 1,
  `created_at`          DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_subscriber_id` (`subscriber_id`),
  CONSTRAINT `fk_ondcconfig_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: vendors
-- ============================================================
CREATE TABLE IF NOT EXISTS `vendors` (
  `id`                  INT(11)      NOT NULL AUTO_INCREMENT,
  `tenant_id`           INT(11)      NOT NULL,
  `external_vendor_id`  VARCHAR(100) DEFAULT NULL,
  `business_name`       VARCHAR(200) NOT NULL,
  `gstin`               VARCHAR(20)  DEFAULT NULL,
  `fssai_number`        VARCHAR(50)  DEFAULT NULL,
  `phone`               VARCHAR(20)  DEFAULT NULL,
  `email`               VARCHAR(200) DEFAULT NULL,
  `address`             TEXT         DEFAULT NULL,
  `city`                VARCHAR(100) DEFAULT NULL,
  `state`               VARCHAR(100) DEFAULT NULL,
  `pincode`             VARCHAR(10)  DEFAULT NULL,
  `gps`                 VARCHAR(50)  DEFAULT NULL,
  `logo_url`            VARCHAR(500) DEFAULT NULL,
  `bank_account`        VARCHAR(50)  DEFAULT NULL,
  `bank_ifsc`           VARCHAR(20)  DEFAULT NULL,
  `status`              ENUM('active','inactive','pending') DEFAULT 'active',
  `created_at`          DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenant_status` (`tenant_id`, `status`),
  CONSTRAINT `fk_vendors_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add missing vendor columns (safe — skipped if already exist)
CALL AddColIfNotExists('vendors', 'bank_account',   "VARCHAR(50) DEFAULT NULL");
CALL AddColIfNotExists('vendors', 'bank_ifsc',      "VARCHAR(20) DEFAULT NULL");
-- std_city_code: ONDC city code like 'std:044' for Chennai, NULL = nationwide
CALL AddColIfNotExists('vendors', 'std_city_code',  "VARCHAR(20) DEFAULT NULL");

-- ============================================================
-- TABLE: products
-- ============================================================
CREATE TABLE IF NOT EXISTS `products` (
  `id`                  INT(11)       NOT NULL AUTO_INCREMENT,
  `tenant_id`           INT(11)       NOT NULL,
  `vendor_id`           INT(11)       NOT NULL,
  `external_product_id` VARCHAR(100)  NOT NULL,
  `name`                VARCHAR(300)  NOT NULL,
  `short_description`   VARCHAR(500)  DEFAULT NULL,
  `description`         TEXT          DEFAULT NULL,
  `category`            VARCHAR(100)  DEFAULT 'grocery',
  `hsn_code`            VARCHAR(20)   DEFAULT NULL,
  `price`               DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `mrp`                 DECIMAL(10,2) DEFAULT NULL,
  `stock`               INT(11)       DEFAULT 0,
  `unit`                VARCHAR(20)   DEFAULT 'piece',
  `currency`            VARCHAR(10)   DEFAULT 'INR',
  `images`              TEXT          DEFAULT NULL,
  `image_url`           VARCHAR(500)  DEFAULT NULL,
  `is_returnable`       TINYINT(1)    DEFAULT 0,
  `is_cancellable`      TINYINT(1)    DEFAULT 1,
  `return_window`       VARCHAR(20)   DEFAULT 'P1D',
  `time_to_ship`        VARCHAR(20)   DEFAULT 'PT24H',
  `available_on_cod`    TINYINT(1)    DEFAULT 1,
  `is_active`           TINYINT(1)    DEFAULT 1,
  `ondc_sync_status`    ENUM('pending','synced','failed') DEFAULT 'pending',
  `last_synced_at`      DATETIME      DEFAULT NULL,
  `created_at`          DATETIME      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_external` (`tenant_id`, `external_product_id`),
  KEY `idx_vendor_active` (`vendor_id`, `is_active`),
  CONSTRAINT `fk_products_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_products_vendor` FOREIGN KEY (`vendor_id`) REFERENCES `vendors` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add missing product columns
CALL AddColIfNotExists('products', 'short_description', "VARCHAR(500) DEFAULT NULL");
CALL AddColIfNotExists('products', 'return_window',     "VARCHAR(20) DEFAULT 'P1D'");
CALL AddColIfNotExists('products', 'currency',          "VARCHAR(10) DEFAULT 'INR'");
CALL AddColIfNotExists('products', 'last_synced_at',    "DATETIME DEFAULT NULL");

-- ============================================================
-- TABLE: ondc_orders
-- ============================================================
CREATE TABLE IF NOT EXISTS `ondc_orders` (
  `id`                  INT(11)       NOT NULL AUTO_INCREMENT,
  `tenant_id`           INT(11)       NOT NULL,
  `vendor_id`           INT(11)       DEFAULT NULL,
  `ondc_order_id`       VARCHAR(200)  NOT NULL,
  `ondc_transaction_id` VARCHAR(200)  DEFAULT NULL,
  `ondc_message_id`     VARCHAR(200)  DEFAULT NULL,
  `cottkart_order_id`   VARCHAR(100)  DEFAULT NULL,
  `bap_id`              VARCHAR(200)  DEFAULT NULL,
  `bap_uri`             VARCHAR(500)  DEFAULT NULL,
  `status`              ENUM('confirmed','packed','shipped','delivered','cancelled','returned') DEFAULT 'confirmed',
  `total_amount`        DECIMAL(10,2) DEFAULT 0.00,
  `currency`            VARCHAR(10)   DEFAULT 'INR',
  `buyer_name`          VARCHAR(200)  DEFAULT NULL,
  `buyer_phone`         VARCHAR(20)   DEFAULT NULL,
  `buyer_email`         VARCHAR(200)  DEFAULT NULL,
  `delivery_address`    TEXT          DEFAULT NULL,
  `delivery_city`       VARCHAR(100)  DEFAULT NULL,
  `delivery_pincode`    VARCHAR(10)   DEFAULT NULL,
  `items`               LONGTEXT      DEFAULT NULL,
  `fulfillment`         TEXT          DEFAULT NULL,
  `payment`             TEXT          DEFAULT NULL,
  `quote`               TEXT          DEFAULT NULL,
  `raw_payload`         LONGTEXT      DEFAULT NULL,
  `shipped_at`          DATETIME      DEFAULT NULL,
  `delivered_at`        DATETIME      DEFAULT NULL,
  `cancelled_at`        DATETIME      DEFAULT NULL,
  `created_at`          DATETIME      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ondc_order_id` (`ondc_order_id`),
  KEY `idx_tenant_status` (`tenant_id`, `status`),
  KEY `idx_transaction_id` (`ondc_transaction_id`),
  CONSTRAINT `fk_orders_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add missing order columns
CALL AddColIfNotExists('ondc_orders', 'cottkart_order_id', "VARCHAR(100) DEFAULT NULL");
CALL AddColIfNotExists('ondc_orders', 'shipped_at',        "DATETIME DEFAULT NULL");
CALL AddColIfNotExists('ondc_orders', 'delivered_at',      "DATETIME DEFAULT NULL");
CALL AddColIfNotExists('ondc_orders', 'cancelled_at',      "DATETIME DEFAULT NULL");

-- ============================================================
-- TABLE: sync_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS `sync_logs` (
  `id`              INT(11)     NOT NULL AUTO_INCREMENT,
  `tenant_id`       INT(11)     NOT NULL,
  `sync_type`       VARCHAR(50) NOT NULL,
  `status`          ENUM('success','failed','partial') DEFAULT 'success',
  `records_synced`  INT(11)     DEFAULT 0,
  `records_failed`  INT(11)     DEFAULT 0,
  `details`         TEXT        DEFAULT NULL,
  `started_at`      DATETIME    DEFAULT NULL,
  `completed_at`    DATETIME    DEFAULT CURRENT_TIMESTAMP,
  `created_at`      DATETIME    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenant_type` (`tenant_id`, `sync_type`),
  CONSTRAINT `fk_synclogs_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add missing sync_log columns
CALL AddColIfNotExists('sync_logs', 'records_synced', "INT(11) DEFAULT 0");
CALL AddColIfNotExists('sync_logs', 'records_failed', "INT(11) DEFAULT 0");
CALL AddColIfNotExists('sync_logs', 'details',        "TEXT DEFAULT NULL");
CALL AddColIfNotExists('sync_logs', 'started_at',     "DATETIME DEFAULT NULL");

-- ============================================================
-- TABLE: ondc_transactions  (NEW)
-- ============================================================
CREATE TABLE IF NOT EXISTS `ondc_transactions` (
  `id`             INT(11)      NOT NULL AUTO_INCREMENT,
  `tenant_id`      INT(11)      DEFAULT NULL,
  `action`         VARCHAR(50)  NOT NULL,
  `direction`      ENUM('in','out') NOT NULL DEFAULT 'out',
  `transaction_id` VARCHAR(200) DEFAULT NULL,
  `message_id`     VARCHAR(200) DEFAULT NULL,
  `bap_id`         VARCHAR(200) DEFAULT NULL,
  `payload`        LONGTEXT     DEFAULT NULL,
  `response`       TEXT         DEFAULT NULL,
  `status`         ENUM('pending','success','failed') DEFAULT 'pending',
  `created_at`     DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_transaction_id` (`transaction_id`),
  KEY `idx_tenant_action`  (`tenant_id`, `action`),
  KEY `idx_status`         (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: issue_grievances  (NEW)
-- ============================================================
CREATE TABLE IF NOT EXISTS `issue_grievances` (
  `id`                INT(11)     NOT NULL AUTO_INCREMENT,
  `tenant_id`         INT(11)     NOT NULL,
  `transaction_id`    VARCHAR(200) DEFAULT NULL,
  `issue_id`          VARCHAR(200) NOT NULL,
  `order_id`          VARCHAR(200) DEFAULT NULL,
  `issue_type`        VARCHAR(100) DEFAULT NULL,
  `category`          VARCHAR(100) DEFAULT NULL,
  `sub_category`      VARCHAR(100) DEFAULT NULL,
  `description`       TEXT         DEFAULT NULL,
  `status`            ENUM('open','in_progress','resolved','closed') DEFAULT 'open',
  `resolution`        TEXT         DEFAULT NULL,
  `remarks`           TEXT         DEFAULT NULL,
  `complainant_name`  VARCHAR(200) DEFAULT NULL,
  `complainant_phone` VARCHAR(20)  DEFAULT NULL,
  `complainant_email` VARCHAR(200) DEFAULT NULL,
  `raw_payload`       LONGTEXT     DEFAULT NULL,
  `created_at`        DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_issue_id` (`issue_id`),
  KEY `idx_tenant_status` (`tenant_id`, `status`),
  KEY `idx_order_id`      (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: settlements  (NEW)
-- ============================================================
CREATE TABLE IF NOT EXISTS `settlements` (
  `id`                  INT(11)       NOT NULL AUTO_INCREMENT,
  `tenant_id`           INT(11)       NOT NULL,
  `vendor_id`           INT(11)       DEFAULT NULL,
  `order_id`            INT(11)       DEFAULT NULL,
  `ondc_order_id`       VARCHAR(200)  DEFAULT NULL,
  `total_amount`        DECIMAL(10,2) DEFAULT 0.00,
  `buyer_app_fee`       DECIMAL(10,2) DEFAULT 0.00,
  `platform_commission` DECIMAL(10,2) DEFAULT 0.00,
  `seller_payout`       DECIMAL(10,2) DEFAULT 0.00,
  `status`              ENUM('pending','processed','failed') DEFAULT 'pending',
  `utr_number`          VARCHAR(100)  DEFAULT NULL,
  `processed_at`        DATETIME      DEFAULT NULL,
  `created_at`          DATETIME      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenant_status` (`tenant_id`, `status`),
  KEY `idx_order_id`      (`order_id`),
  CONSTRAINT `fk_settlements_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: webhooks
-- ============================================================
CREATE TABLE IF NOT EXISTS `webhooks` (
  `id`         INT(11)      NOT NULL AUTO_INCREMENT,
  `tenant_id`  INT(11)      NOT NULL,
  `url`        VARCHAR(500) NOT NULL,
  `event`      VARCHAR(100) NOT NULL,
  `secret`     VARCHAR(200) DEFAULT NULL,
  `is_active`  TINYINT(1)   DEFAULT 1,
  `created_at` DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenant_event` (`tenant_id`, `event`),
  CONSTRAINT `fk_webhooks_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TABLE: webhook_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS `webhook_logs` (
  `id`            INT(11)     NOT NULL AUTO_INCREMENT,
  `tenant_id`     INT(11)     DEFAULT NULL,
  `webhook_id`    INT(11)     DEFAULT NULL,
  `event`         VARCHAR(100) DEFAULT NULL,
  `payload`       LONGTEXT    DEFAULT NULL,
  `response_code` INT(11)     DEFAULT NULL,
  `status`        ENUM('success','failed') DEFAULT 'failed',
  `created_at`    DATETIME    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenant_status` (`tenant_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- CLEANUP
-- ============================================================
DROP PROCEDURE IF EXISTS AddColIfNotExists;

-- ============================================================
-- SEED: Default tenant + ONDC config (edit values before running)
-- Uncomment and fill in your actual values
-- ============================================================
/*
INSERT IGNORE INTO `tenants` (id, name, slug, email, status)
VALUES (1, 'CottKart', 'cottkart', 'admin@cottkart.com', 'active');

INSERT IGNORE INTO `api_keys` (tenant_id, key_value, name)
VALUES (1, 'ck_live_YOUR_API_KEY_HERE', 'Production Key');

INSERT IGNORE INTO `tenant_ondc_config`
  (tenant_id, subscriber_id, subscriber_url, ondc_env,
   signing_private_key, signing_public_key, unique_key_id, key_valid_until)
VALUES
  (1,
   'ondc.cottkart.com',
   'https://ondc.cottkart.com',
   'preprod',
   'YOUR_ED25519_PRIVATE_KEY_BASE64',
   'YOUR_ED25519_PUBLIC_KEY_BASE64',
   'YOUR_UNIQUE_KEY_ID',
   '2027-05-15 00:00:00');
*/

-- ============================================================
-- VERIFY: Check all tables exist
-- ============================================================
SELECT table_name, table_rows
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'tenants', 'api_keys', 'tenant_ondc_config',
    'vendors', 'products', 'ondc_orders',
    'sync_logs', 'ondc_transactions',
    'issue_grievances', 'settlements',
    'webhooks', 'webhook_logs'
  )
ORDER BY table_name;
