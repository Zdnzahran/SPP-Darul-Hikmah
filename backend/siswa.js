const express = require('express');
const db = require('./db');
const { kunciBendahara } = require('./auth');

const router = express.Router();

// DAFTARKAN SISWA BARU + 3 JENIS TAGIHAN AWAL (POST /api/siswa)
router.post('/', kunciBendahara, async (req, res) => {
  // Memulai sesi transaksi database
  const koneksiTransaksi = await db.getConnection();
  await koneksiTransaksi.beginTransaction();

  try {
    const nama = req.body.nama ? req.body.nama.trim() : '';
    const { kelas_id, spp_bulanan_id, spp_pengembangan_id, spp_tahunan_id, bulan_mulai_tagih, saldo_awal } = req.body;

    // 1. Validasi Input Wajib (Kunci untuk 3 jenis SPP wajib)
    if (!nama || !kelas_id || !spp_bulanan_id || !spp_pengembangan_id || !spp_tahunan_id || !bulan_mulai_tagih) {
      await koneksiTransaksi.rollback();
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Semua kolom data siswa termasuk 3 jenis SPP wajib diisi." }
      });
    }

    // Format tanggal mulai tagih harus diatur ke tanggal 1 (YYYY-MM-01)
    const tanggalMulai = `${bulan_mulai_tagih.substring(0, 7)}-01`;

    // 2. ATURAN BISNIS: Cek Peringatan Nama Kembar di Kelas yang Sama
    const [cekKembar] = await koneksiTransaksi.query(
      'SELECT id FROM siswa WHERE nama = ? AND kelas_id = ? AND status = "aktif" AND dihapus_pada IS NULL',
      [nama, kelas_id]
    );

    let adaPeringatan = false;
    if (cekKembar.length > 0) {
      adaPeringatan = true;
    }

    // 3. Ambil Nilai Biaya SPP dari DB untuk Dibekukan ke Tabel Tagihan
    const [resBln] = await koneksiTransaksi.query('SELECT biaya FROM spp WHERE id = ? AND jenis = "bulanan" AND dihapus_pada IS NULL', [spp_bulanan_id]);
    const [resPgb] = await koneksiTransaksi.query('SELECT biaya FROM spp WHERE id = ? AND jenis = "pengembangan" AND dihapus_pada IS NULL', [spp_pengembangan_id]);
    const [resThn] = await koneksiTransaksi.query('SELECT biaya FROM spp WHERE id = ? AND jenis = "tahunan" AND dihapus_pada IS NULL', [spp_tahunan_id]);

    // Validasi jika ada ID master SPP yang salah ketik atau tidak ditemukan
    if (resBln.length === 0 || resPgb.length === 0 || resThn.length === 0) {
      await koneksiTransaksi.rollback();
      return res.status(404).json({
        error: { kode: "TIDAK_DITEMUKAN", pesan: "Salah satu golongan ID SPP yang Anda masukkan tidak valid di database." }
      });
    }

    const biayaBulanan = resBln[0].biaya;
    const biayaPengembangan = resPgb[0].biaya;
    const biayaTahunan = resThn[0].biaya;

    // 4. INSERT DATA SISWA BARU KEDALAM TABEL MYSQL
    const [resultSiswa] = await koneksiTransaksi.query(
      `INSERT INTO siswa (nama, kelas_id, spp_bulanan_id, spp_pengembangan_id, spp_tahunan_id, bulan_mulai_tagih) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nama, kelas_id, spp_bulanan_id, spp_pengembangan_id, spp_tahunan_id, tanggalMulai]
    );
    const idSiswaBaru = resultSiswa.insertId;

    // 5. OTOMATIS GENERATE LEMBAR TAGIHAN PENGEMBANGAN (Tunggal & Penuh, bulan = NULL)
    await koneksiTransaksi.query(
      `INSERT INTO tagihan (siswa_id, jenis, bulan, nominal, spp_id) VALUES (?, 'pengembangan', NULL, ?, ?)`,
      [idSiswaBaru, biayaPengembangan, spp_pengembangan_id]
    );

    // 6. OTOMATIS GENERATE LEMBAR TAGIHAN BULANAN PERDANA
    await koneksiTransaksi.query(
      `INSERT INTO tagihan (siswa_id, jenis, bulan, nominal, spp_id) VALUES (?, 'bulanan', ?, ?, ?)`,
      [idSiswaBaru, tanggalMulai, biayaBulanan, spp_bulanan_id]
    );

    // 7. OTOMATIS GENERATE LEMBAR TAGIHAN TAHUNAN KURIKULUM PERDANA
    await koneksiTransaksi.query(
      `INSERT INTO tagihan (siswa_id, jenis, bulan, nominal, spp_id) VALUES (?, 'tahunan', ?, ?, ?)`,
      [idSiswaBaru, tanggalMulai, biayaTahunan, spp_tahunan_id]
    );

    // 8. ATURAN BISNIS: Manajemen Pencatatan Saldo Awal Siswa Lama
    if (saldo_awal) {
      const bulananSudahDibayar = parseInt(saldo_awal.bulanan_sudah_dibayar) || 0;
      const pengembanganSudahDibayar = parseInt(saldo_awal.pengembangan_sudah_dibayar) || 0;
      const tahunanSudahDibayar = parseInt(saldo_awal.tahunan_sudah_dibayar) || 0;
      const hariIni = new Date().toISOString().slice(0, 10);

      if (pengembanganSudahDibayar > 0) {
        await koneksiTransaksi.query(
          `INSERT INTO pembayaran (siswa_id, jenis, tanggal, nominal, catatan, sumber) VALUES (?, 'pengembangan', ?, ?, 'Saldo awal', 'saldo_awal')`,
          [idSiswaBaru, hariIni, pengembanganSudahDibayar]
        );
      }
      if (bulananSudahDibayar > 0) {
        await koneksiTransaksi.query(
          `INSERT INTO pembayaran (siswa_id, jenis, tanggal, nominal, catatan, sumber) VALUES (?, 'bulanan', ?, ?, 'Saldo awal', 'saldo_awal')`,
          [idSiswaBaru, hariIni, bulananSudahDibayar]
        );
      }
      if (tahunanSudahDibayar > 0) {
        await koneksiTransaksi.query(
          `INSERT INTO pembayaran (siswa_id, jenis, tanggal, nominal, catatan, sumber) VALUES (?, 'tahunan', ?, ?, 'Saldo awal', 'saldo_awal')`,
          [idSiswaBaru, hariIni, tahunanSudahDibayar]
        );
      }
    }

    // Komit transaksi data jika semua sukses tanpa kendala
    await koneksiTransaksi.commit();

    res.status(201).json({
      siswa: {
        id: idSiswaBaru,
        nama: nama,
        kelas_id: parseInt(kelas_id),
        bulan_mulai_tagih: tanggalMulai
      },
      peringatan: adaPeringatan ? "Siswa dengan nama dan kelas yang sama sudah terdaftar." : null,
      pesan: "Data siswa beserta 3 bon tagihan awal sukses dikunci ke sistem."
    });

  } catch (error) {
    await koneksiTransaksi.rollback();
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  } finally {
    koneksiTransaksi.release();
  }
});

module.exports = router;
