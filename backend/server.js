const express = require('express');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const db = require('./db');
const { authRouter } = require('./auth');

dotenv.config();

const app = express();

// Set zona waktu global Node.js ke WIB
process.env.TZ = 'Asia/Jakarta';

// Middleware CORS
app.use(cors({
  origin: 'http://localhost:3000', // Alamat React Frontend Anda nantinya
  credentials: true // Wajib bernilai true agar browser mau menerima cookie
}));

app.use(express.json());

// Konfigurasi Sistem Keamanan Sesi Cookie
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, // Amankan cookie dari serangan pencurian XSS script
    secure: false,  // Set ke true jika di live server production (HTTPS)
    sameSite: 'lax', // Batasi pengiriman cookie lintas situs demi keamanan
    maxAge: 24 * 60 * 60 * 1000 // Masa aktif sesi: 1 Hari penuh (dalam milidetik)
  }
}));

// Keamanan: Pembatasan Percobaan Login (Maks 5 kali gagal per 15 menit per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: { error: { kode: "TERLALU_BANYAK_PERCOBAAN", pesan: "Terlalu banyak percobaan login gagal. Silakan coba lagi dalam 15 menit." } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Registrasi Rute API Autentikasi (Gunakan limiter khusus untuk jalur login)
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);

const kelasRouter = require('./kelas');
app.use('/api/kelas', kelasRouter);

const sppRouter = require('./spp');
app.use('/api/spp', sppRouter);

const siswaRouter = require('./siswa');
app.use('/api/siswa', siswaRouter);

const { tagihanRouter } = require('./tagihan');
app.use('/api/tagihan', tagihanRouter);

const pembayaranRouter = require('./pembayaran');
app.use('/api/pembayaran', pembayaranRouter);

// Endpoint Cek Kesehatan Server
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ 
      status: "ONLINE", 
      database: "TERHUBUNG",
      waktu_server: new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) 
    });
  } catch (error) {
    res.status(500).json({ status: "ERROR", pesan: error.message });
  }
});

// Jalankan Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Server Backend SPP Darul Hikmah Berjalan di Port ${PORT}`);
  console.log(`Zona Waktu Diatur ke: ${process.env.TZ}`);
  console.log(`==================================================`);
});
