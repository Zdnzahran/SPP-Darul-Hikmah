const express = require('express');
const db = require('./db');
const { kunciBendahara } = require('./auth');

const router = express.Router();

// ENDPOINT MENCATAT PEMBAYARAN BARU (POST /api/pembayaran)
router.post('/', kunciBendahara, async (req, res) => {
  const { siswa_id, jenis, tanggal, nominal, catatan } = req.body;

  // 1. Validasi Input Dasar
  if (!siswa_id || !jenis || !tanggal || !nominal) {
    return res.status(400).json({
      error: { kode: "VALIDASI_GAGAL", pesan: "Kolom siswa_id, jenis, tanggal, dan nominal wajib diisi." }
    });
  }

  if (jenis !== 'bulanan' && jenis !== 'pengembangan' && jenis !== 'tahunan') {
    return res.status(400).json({
      error: { kode: "VALIDASI_GAGAL", pesan: "Jenis SPP harus antara 'bulanan', 'pengembangan', atau 'tahunan'." }
    });
  }

  if (parseInt(nominal) <= 0) {
    return res.status(400).json({
      error: { kode: "VALIDASI_GAGAL", pesan: "Nominal pembayaran harus lebih besar dari Rp 0." }
    });
  }

  try {
    // 2. Cek apakah siswa eksis dan aktif
    const [cekSiswa] = await db.query(
      "SELECT id, nama, status FROM siswa WHERE id = ? AND dihapus_pada IS NULL", 
      [siswa_id]
    );
    if (cekSiswa.length === 0) {
      return res.status(404).json({
        error: { kode: "TIDAK_DITEMUKAN", pesan: "Data siswa tidak ditemukan atau sudah dihapus." }
      });
    }

    const siswa = cekSiswa[0];

    // 3. KALKULASI REAL-TIME SISA TAGIHAN (Sesuai Aturan Bisnis Blueprint)
    const [[kalkulasi]] = await db.query(`
      SELECT 
        (SELECT COALESCE(SUM(nominal), 0) FROM tagihan WHERE siswa_id = ? AND jenis = ? AND dihapus_pada IS NULL) AS total_tagihan,
        (SELECT COALESCE(SUM(nominal), 0) FROM pembayaran WHERE siswa_id = ? AND jenis = ? AND dihapus_pada IS NULL) AS total_dibayar
    `, [siswa_id, jenis, siswa_id, jenis]);

    const sisaTagihan = Math.max(kalkulasi.total_tagihan - kalkulasi.total_dibayar, 0);


    // 4. ATURAN BISNIS: Validasi Pembatasan Nominal Uang Masuk Berdasarkan Jenis SPP
    if (jenis === 'pengembangan' || jenis === 'tahunan') {
      if (parseInt(nominal) > sisaTagihan) {
        return res.status(400).json({
          error: { 
            kode: "VALIDASI_GAGAL", 
            pesan: `Nominal pembayaran melebihi sisa tagihan ${jenis}. Sisa tagihan saat ini adalah Rp ${sisaTagihan.toLocaleString('id-ID')}. Kelebihan bayar ditolak.` 
          }
        });
      }
    } else if (jenis === 'bulanan') {
      // Pembatasan opsional untuk mencegah typo fatal bendahara (Misal batas bayar di muka maks 12 bulan)
      const [golonganSpp] = await db.query(`
        SELECT j.biaya FROM siswa s 
        JOIN spp j ON s.spp_bulanan_id = j.id WHERE s.id = ?
      `, [siswa_id]);
      
      const biayaBulananSiswa = golonganSpp[0].biaya;
      const batasMaksimalBayar = sisaTagihan + (12 * biayaBulananSiswa);

      if (parseInt(nominal) > batasMaksimalBayar) {
        return res.status(400).json({
          error: { 
            kode: "VALIDASI_GAGAL", 
            pesan: `Nominal terlalu besar. Maksimal pembayaran di muka yang diizinkan sistem adalah 12 bulan ke depan.` 
          }
        });
      }
    }

    // 5. EKSEKUSI SIMPAN PEMBAYARAN KE MYSQL
    const [result] = await db.query(
      `INSERT INTO pembayaran (siswa_id, jenis, tanggal, nominal, catatan, sumber) 
       VALUES (?, ?, ?, ?, ?, 'normal')`,
      [siswa_id, jenis, tanggal, nominal, catatan || null]
    );

    // 6. HITUNG ULANG RINGKASAN TERBARU UNTUK DIKEMBALIKAN KE FRONTEND
    const [[kalkulasiBaru]] = await db.query(`
      SELECT 
        (SELECT COALESCE(SUM(nominal), 0) FROM tagihan WHERE siswa_id = ? AND jenis = ? AND dihapus_pada IS NULL) AS total_tagihan,
        (SELECT COALESCE(SUM(nominal), 0) FROM pembayaran WHERE siswa_id = ? AND jenis = ? AND dihapus_pada IS NULL) AS total_dibayar
    `, [siswa_id, jenis, siswa_id, jenis]);

    const sisaTerbaru = Math.max(kalkulasiBaru.total_tagihan - kalkulasiBaru.total_dibayar, 0);
    const saldoTerbaru = Math.max(kalkulasiBaru.total_dibayar - kalkulasiBaru.total_tagihan, 0);

    // Mengembalikan respons sukses sesuai spesifikasi API Blueprint JSON
    res.status(201).json({
      pembayaran: {
        id: result.insertId,
        siswa_id: parseInt(siswa_id),
        nama_siswa: siswa.nama,
        jenis,
        tanggal,
        nominal: parseInt(nominal),
        catatan
      },
      ringkasan_terbaru_siswa: {
        jenis,
        total_tagihan: parseInt(kalkulasiBaru.total_tagihan),
        total_dibayar: parseInt(kalkulasiBaru.total_dibayar),
        sisa: sisaTerbaru,
        saldo: saldoTerbaru, // Menyimpan kelebihan bayar otomatis (Hanya untuk bulanan)
        lunas: sisaTerbaru === 0
      }
    });

  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

module.exports = router;
