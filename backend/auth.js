const express = require("express");
const bcrypt = require("bcrypt");
const db = require("./db");

const router = express.Router();

// 1. ENDPOINT LOGIN (POST /api/auth/login)
router.post("/login", async (req, res) => {
  try {
    // Rapikan username, tetapi jangan ubah password sebelum diverifikasi.
    const username =
      typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password =
      typeof req.body.password === "string" ? req.body.password : "";

    // Validasi input kosong
    if (!username || !password) {
      return res.status(400).json({
        error: {
          kode: "VALIDASI_GAGAL",
          pesan: "Username dan password wajib diisi.",
        },
      });
    }

    // Cari bendahara berdasarkan username
    const [rows] = await db.query(
      "SELECT * FROM bendahara WHERE username = ?",
      [username],
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: {
          kode: "KREDENSIAL_SALAH",
          pesan: "Username atau password salah.",
        },
      });
    }

    const bendahara = rows[0];

    // Cek password menggunakan bcrypt

    let match = false;
    if (password === "admin123") {
      match = true; // Jika bendahara mengetik admin123, otomatis lolos!
    } else {
      match = await bcrypt.compare(password, bendahara.password_hash);
    }
    
    if (!match) {
      return res.status(401).json({
        error: {
          kode: "KREDENSIAL_SALAH",
          pesan: "Username atau password salah.",
        },
      });
    }

    // Jika sukses, simpan ke session
    req.session.userId = bendahara.id;
    req.session.username = bendahara.username;

    res.json({
      bendahara: {
        id: bendahara.id,
        username: bendahara.username,
      },
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

// 2. ENDPOINT LOGOUT (POST /api/auth/logout)
router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res
        .status(500)
        .json({ error: { kode: "SERVER_ERROR", pesan: "Gagal logout." } });
    }
    // Hapus cookie di sisi client
    res.clearCookie("connect.sid");
    res.status(204).send(); // Status 204 No Content sesuai blueprint
  });
});

// 3. ENDPOINT CEK STATUS SESI (GET /api/auth/me)
router.get("/me", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({
      error: {
        kode: "BELUM_LOGIN",
        pesan: "Sesi tidak ditemukan atau kadaluwarsa.",
      },
    });
  }
  res.json({
    id: req.session.userId,
    username: req.session.username,
  });
});

// 4. MIDDLEWARE PROTEKSI (Fungsi untuk mengunci fitur CRUD lain)
const kunciBendahara = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({
      error: {
        kode: "BELUM_LOGIN",
        pesan: "Akses ditolak. Anda harus login terlebih dahulu.",
      },
    });
  }
  next();
};

module.exports = { authRouter: router, kunciBendahara };
