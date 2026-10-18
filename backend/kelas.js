const express = require('express');
const db = require('./db');
const { kunciBendahara } = require('./auth');

const router = express.Router();

// 1. AMBIL SEMUA DATA KELAS (GET /api/kelas)
// Otomatis menyaring data yang belum dihapus (dihapus_pada IS NULL)
router.get('/', kunciBendahara, async (req, res) => {
  try {
    // Query ini juga menghitung jumlah siswa aktif di setiap kelas secara real-time
    const [rows] = await db.query(`
      SELECT k.id, k.nama, COUNT(s.id) AS jumlah_siswa_aktif 
      FROM kelas k
      LEFT JOIN siswa s ON k.id = s.kelas_id AND s.dihapus_pada IS NULL AND s.status = 'aktif'
      WHERE k.dihapus_pada IS NULL
      GROUP BY k.id
      ORDER BY k.nama ASC
    `);
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

// 2. TAMBAH KELAS BARU (POST /api/kelas)
router.post('/', kunciBendahara, async (req, res) => {
  try {
    const nama = req.body.nama ? req.body.nama.trim() : '';

    if (!nama) {
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Nama kelas wajib diisi." }
      });
    }

    // Cek apakah nama kelas sudah ada dan belum dihapus
    const [cekDuplikat] = await db.query(
      'SELECT id FROM kelas WHERE nama = ? AND dihapus_pada IS NULL', 
      [nama]
    );

    if (cekDuplikat.length > 0) {
      return res.status(409).json({
        error: { kode: "NAMA_DUPLIKAT", pesan: `Kelas dengan nama "${nama}" sudah ada.` }
      });
    }

    // Masukkan data baru ke database
    const [result] = await db.query('INSERT INTO kelas (nama) VALUES (?)', [nama]);
    
    res.status(201).json({
      id: result.insertId,
      nama: nama
    });
  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

// 3. UBAH NAMA KELAS (PUT /api/kelas/:id)
router.put('/:id', kunciBendahara, async (req, res) => {
  try {
    const { id } = req.params;
    const nama = req.body.nama ? req.body.nama.trim() : '';

    if (!nama) {
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Nama kelas wajib diisi." }
      });
    }

    // Cek apakah kelas yang mau diubah ada di database
    const [cekEksis] = await db.query('SELECT id FROM kelas WHERE id = ? AND dihapus_pada IS NULL', [id]);
    if (cekEksis.length === 0) {
      return res.status(404).json({
        error: { kode: "TIDAK_DITEMUKAN", pesan: "Data kelas tidak ditemukan atau sudah dihapus." }
      });
    }

    // Cek apakah nama baru bentrok dengan kelas lain yang sudah ada
    const [cekDuplikat] = await db.query(
      'SELECT id FROM kelas WHERE nama = ? AND id != ? AND dihapus_pada IS NULL', 
      [nama, id]
    );

    if (cekDuplikat.length > 0) {
      return res.status(409).json({
        error: { kode: "NAMA_DUPLIKAT", pesan: `Nama kelas "${nama}" sudah digunakan oleh kelas lain.` }
      });
    }

    // Eksekusi pembaruan data
    await db.query('UPDATE kelas SET nama = ? WHERE id = ?', [nama, id]);
    
    res.json({ id: parseInt(id), nama });
  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

// 4. HAPUS KELAS / SOFT DELETE (DELETE /api/kelas/:id)
router.delete('/:id', kunciBendahara, async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Cek apakah kelas eksis
    const [cekEksis] = await db.query('SELECT id FROM kelas WHERE id = ? AND dihapus_pada IS NULL', [id]);
    if (cekEksis.length === 0) {
      return res.status(404).json({
        error: { kode: "TIDAK_DITEMUKAN", pesan: "Data kelas tidak ditemukan atau sudah dihapus." }
      });
    }

    // 2. ATURAN BISNIS: Cek apakah masih ada siswa aktif di kelas ini
    const [cekSiswa] = await db.query(
      "SELECT id FROM siswa WHERE kelas_id = ? AND status = 'aktif' AND dihapus_pada IS NULL", 
      [id]
    );

    if (cekSiswa.length > 0) {
      return res.status(409).json({
        error: { 
          kode: "KONFLIK_DATA", 
          pesan: "Kelas tidak boleh dihapus karena masih memiliki siswa aktif di dalamnya." 
        }
      });
    }

    // 3. Eksekusi SOFT DELETE (Mengisi kolom dihapus_pada dengan waktu sekarang)
    const waktu_sekarang = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await db.query('UPDATE kelas SET dihapus_pada = ? WHERE id = ?', [waktu_sekarang, id]);

    res.status(204).send(); // Status 204 No Content sesuai spesifikasi blueprint JSON
  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

module.exports = router;
