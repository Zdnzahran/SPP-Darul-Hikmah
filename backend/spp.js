const express = require('express');
const db = require('./db');
const { kunciBendahara } = require('./auth');

const router = express.Router();

// 1. AMBIL SEMUA DATA GOLONGAN SPP (GET /api/spp)
// Bisa difilter lewat query, misal: /api/spp?jenis=bulanan
router.get('/', kunciBendahara, async (req, res) => {
  try {
    const { jenis } = req.query;
    let query = 'SELECT id, nama, jenis, biaya FROM spp WHERE dihapus_pada IS NULL';
    let params = [];

    // Jika bendahara memfilter berdasarkan jenis tertentu
    if (jenis === 'bulanan' || jenis === 'pengembangan') {
      query += ' AND jenis = ?';
      params.push(jenis);
    }

    query += ' ORDER BY jenis DESC, biaya DESC';
    const [rows] = await db.query(query, params);
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

// 2. TAMBAH GOLONGAN SPP BARU (POST /api/spp)
router.post('/', kunciBendahara, async (req, res) => {
  try {
    const nama = req.body.nama ? req.body.nama.trim() : '';
    const { jenis, biaya } = req.body;

    // Validasi input wajib
    if (!nama || !jenis || !biaya) {
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Kolom nama, jenis, dan biaya wajib diisi." }
      });
    }

    // Validasi tipe enum jenis
    if (jenis !== 'bulanan' && jenis !== 'pengembangan') {
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Jenis SPP harus antara 'bulanan' atau 'pengembangan'." }
      });
    }

    // Validasi nilai nominal uang harus di atas 0
    if (parseInt(biaya) <= 0) {
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Nominal biaya harus lebih besar dari Rp 0." }
      });
    }

    // Cek duplikasi nama untuk jenis yang sama yang belum dihapus
    const [cekDuplikat] = await db.query(
      'SELECT id FROM spp WHERE nama = ? AND jenis = ? AND dihapus_pada IS NULL',
      [nama, jenis]
    );

    if (cekDuplikat.length > 0) {
      return res.status(409).json({
        error: { kode: "DATA_DUPLIKAT", pesan: `Golongan SPP dengan nama "${nama}" untuk jenis ${jenis} sudah ada.` }
      });
    }

    // Eksekusi insert data ke MySQL
    const [result] = await db.query(
      'INSERT INTO spp (nama, jenis, biaya) VALUES (?, ?, ?)',
      [nama, jenis, biaya]
    );

    res.status(201).json({
      id: result.insertId,
      nama,
      jenis,
      biaya: parseInt(biaya)
    });

  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

// 3. UBAH GOLONGAN SPP (PUT /api/spp/:id)
// Catatan: Jenis SPP tidak boleh diubah setelah dibuat demi kestabilan relasi database
router.put('/:id', kunciBendahara, async (req, res) => {
  try {
    const { id } = req.params;
    const nama = req.body.nama ? req.body.nama.trim() : '';
    const { biaya } = req.body;

    if (!nama || !biaya) {
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Kolom nama dan biaya wajib diisi." }
      });
    }

    if (parseInt(biaya) <= 0) {
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Nominal biaya harus lebih besar dari Rp 0." }
      });
    }

    // Cek apakah data master SPP eksis
    const [cekEksis] = await db.query('SELECT id, jenis FROM spp WHERE id = ? AND dihapus_pada IS NULL', [id]);
    if (cekEksis.length === 0) {
      return res.status(404).json({
        error: { kode: "TIDAK_DITEMUKAN", pesan: "Data golongan SPP tidak ditemukan atau sudah dihapus." }
      });
    }

    const jenis = cekEksis[0].jenis;

    // Cek apakah nama baru bentrok dengan nama lain di jenis yang sama
    const [cekDuplikat] = await db.query(
      'SELECT id FROM spp WHERE nama = ? AND jenis = ? AND id != ? AND dihapus_pada IS NULL',
      [nama, jenis, id]
    );

    if (cekDuplikat.length > 0) {
      return res.status(409).json({
        error: { kode: "DATA_DUPLIKAT", pesan: `Nama "${nama}" sudah digunakan oleh golongan SPP ${jenis} lainnya.` }
      });
    }

    // Jalankan pembaruan data (Hanya mengubah nama dan biaya, tagihan lama tetap aman terkunci di tabel tagihan)
    await db.query('UPDATE spp SET nama = ?, biaya = ? WHERE id = ?', [nama, biaya, id]);

    res.json({
      id: parseInt(id),
      nama,
      jenis,
      biaya: parseInt(biaya)
    });

  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

// 4. HAPUS GOLONGAN SPP / SOFT DELETE (DELETE /api/spp/:id)
router.delete('/:id', kunciBendahara, async (req, res) => {
  try {
    const { id } = req.params;

    // Cek eksistensi data
    const [cekEksis] = await db.query('SELECT id FROM spp WHERE id = ? AND dihapus_pada IS NULL', [id]);
    if (cekEksis.length === 0) {
      return res.status(404).json({
        error: { kode: "TIDAK_DITEMUKAN", pesan: "Data golongan SPP tidak ditemukan atau sudah dihapus." }
      });
    }

    // ATURAN BISNIS: Cek apakah golongan SPP ini masih aktif dipakai oleh siswa
    const [cekSiswa] = await db.query(
      'SELECT id FROM siswa WHERE (spp_bulanan_id = ? OR spp_pengembangan_id = ?) AND dihapus_pada IS NULL',
      [id, id]
    );

    if (cekSiswa.length > 0) {
      return res.status(409).json({
        error: {
          kode: "KONFLIK_DATA",
          pesan: "Golongan SPP tidak boleh dihapus karena masih aktif ditugaskan ke beberapa siswa."
        }
      });
    }

    // Eksekusi SOFT DELETE
    const waktu_sekarang = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await db.query('UPDATE spp SET dihapus_pada = ? WHERE id = ?', [waktu_sekarang, id]);

    res.status(204).send(); // Status 204 No Content sukses tanpa bodi data

  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

module.exports = router;
