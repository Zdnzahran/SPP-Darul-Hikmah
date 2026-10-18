const mysql = require('mysql2');
const dotenv = require('dotenv');

dotenv.config();

// Membuat pool koneksi database
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Mengubah pool menjadi format promise agar kita bisa menggunakan async/await
const db = pool.promise();

module.exports = db;
