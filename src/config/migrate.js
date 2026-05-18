require('dotenv').config();
const mysql = require('mysql2/promise');

const migrate = async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cloudkart_vendor_id VARCHAR(100) UNIQUE,
      business_name VARCHAR(255) NOT NULL,
      gstin VARCHAR(20),
      phone VARCHAR(20),
      email VARCHAR(255),
      address TEXT,
      city VARCHAR(100),
      gps VARCHAR(50),
      status ENUM('pending','active','suspended') DEFAULT 'active',
      ondc_registered_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS ondc_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ondc_order_id VARCHAR(255) UNIQUE,
      cloudkart_order_id VARCHAR(255),
      vendor_id INT,
      status VARCHAR(50) DEFAULT 'pending',
      total_amount DECIMAL(10,2),
      buyer_info JSON,
      items JSON,
      fulfillment JSON,
      payment JSON,
      raw_payload JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS sync_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      vendor_id INT,
      sync_type ENUM('catalog','inventory','order'),
      status ENUM('success','failed','pending'),
      items_synced INT DEFAULT 0,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✓ Database tables created successfully');
  await conn.end();
};

migrate().catch(console.error);
