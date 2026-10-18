const express = require('express');
const db = require('./db');
const { kunciBendahara } = require('./auth');

const router = express.Router();

// 1. DAFTARKAN SISWA BARU + TRANSAKSI TAGIHAN AWAL (POST /api/siswa)
router.post('/', kunciBendahara, async (req, res) => {
  // Memulai sesi transaksi database
  const koneksiTransaksi = await db.getConnection();
  await koneksiTransaksi.beginTransaction();

  try {
    const nama = req.body.nama ? req.body.nama.trim() : '';
    const { kelas_id, spp_bulanan_id, spp_pengembangan_id, bulan_mulai_tagih, saldo_awal } = req.body;

    // 1. Validasi Input Wajib
    if (!nama || !kelas_id || !spp_bulanan_id || !spp_pengembangan_id || !bulan_mulai_tagih) {
      await koneksiTransaksi.rollback();
      return res.status(400).json({
        error: { kode: "VALIDASI_GAGAL", pesan: "Semua kolom data siswa wajib diisi." }
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
      adaPeringatan = true; // Ditandai untuk memicu field peringatan di respons akhir
    }

    // 3. Ambil Nilai Biaya SPP untuk Dibekukan ke Tabel Tagihan
    const [dataSppBulanan] = await koneksiTransaksi.query('SELECT biaya FROM spp WHERE id = ? AND jenis = "bulanan"', [spp_bulanan_id]);
    const [dataSppPengembangan] = await koneksiTransaksi.query('SELECT biaya FROM spp WHERE id = ? AND jenis = "pengembangan"', [spp_pengembangan_id]);

    if (dataSppBulanan.length === 0 || dataSppPengembangan.length === 0) {
      await koneksiTransaksi.rollback();
      return res.status(404).json({
        error: { kode: "TIDAK_DITEMUKAN", pesan: "Golongan SPP yang dipilih tidak valid atau sudah dihapus." }
      });
    }

    const biayaBulanan = dataSppBulanan[0].biaya;
    const biayaPengembangan = dataSppPengembangan[0].biaya;

    // 4. INSERT DATA SISWA
    const [resultSiswa] = await koneksiTransaksi.query(
      `INSERT INTO siswa (nama, kelas_id, spp_bulanan_id, spp_pengembangan_id, bulan_mulai_tagih) 
       VALUES (?, ?, ?, ?, ?)`,
      [nama, kelas_id, spp_bulanan_id, spp_pengembangan_id, tanggalMulai]
    );
    const idSiswaBaru = resultSiswa.insertId;

    // 5. ATURAN BISNIS: Otomatis Buat Tagihan Pengembangan Penuh (Sekali seumur hidup)
    const [resultTagihanPengembangan] = await koneksiTransaksi.query(
      `INSERT INTO tagihan (siswa_id, jenis, bulan, nominal, spp_id) 
       VALUES (?, 'pengembangan', NULL, ?, ?)`,
      [idSiswaBaru, biayaPengembangan, spp_pengembangan_id]
    );
    const idTagihanPengembangan = resultTagihanPengembangan.insertId;

    // 6. ATURAN BISNIS: Otomatis Buat Tagihan Bulanan Pertama (Sesuai bulan_mulai_tagih)
    const [resultTagihanBulanan] = await koneksiTransaksi.query(
      `INSERT INTO tagihan (siswa_id, jenis, bulan, nominal, spp_id) 
       VALUES (?, 'bulanan', ?, ?, ?)`,
      [idSiswaBaru, tanggalMulai, biayaBulanan, spp_bulanan_id]
    );
    const idTagihanBulanan = resultTagihanBulanan.insertId;

    // 7. ATURAN BISNIS: Impor Saldo Awal Siswa Lama (Jika diisi oleh bendahara)
    if (saldo_awal) {
      const bulananSudahDibayar = parseInt(saldo_awal.bulanan_sudah_dibayar) || 0;
      const pengembanganSudahDibayar = parseInt(saldo_awal.pengembangan_sudah_dibayar) || 0;
      const hariIni = new Date().toISOString().slice(0, 10); // Format YYYY-MM-DD

      // Jika ada cicilan pengembangan terdahulu
      if (pengembanganSudahDibayar > 0) {
        if (pengembanganSudahDibayar > biayaPengembangan) {
          await koneksiTransaksi.rollback();
          return res.status(400).json({
            error: { kode: "VALIDASI_GAGAL", pesan: "Saldo awal pengembangan tidak boleh melebihi total nilai tagihannya." }
          });
        }
        await koneksiTransaksi.query(
          `INSERT INTO pembayaran (siswa_id, jenis, tanggal, nominal, catatan, sumber) 
           VALUES (?, 'pengembangan', ?, ?, 'Pemutihan saldo awal siswa lama', 'saldo_awal')`,
          [idSiswaBaru, hariIni, pengembanganSudahDibayar]
        );
      }

      // Jika ada cicilan bulanan terdahulu
      if (bulananSudahDibayar > 0) {
        await koneksiTransaksi.query(
          `INSERT INTO pembayaran (siswa_id, jenis, tanggal, nominal, catatan, sumber) 
           VALUES (?, 'bulanan', ?, ?, 'Pemutihan saldo awal siswa lama', 'saldo_awal')`,
          [idSiswaBaru, hariIni, bulananSudahDibayar]
        );
      }
    }

    // Komit data ke database jika seluruh rangkaian proses di atas sukses tanpa eror
    await koneksiTransaksi.commit();

    // Mengembalikan respons sukses sesuai spesifikasi blueprint JSON
    res.status(201).json({
      siswa: {
        id: idSiswaBaru,
        nama: nama,
        kelas_id: parseInt(kelas_id),
        bulan_mulai_tagih: tanggalMulai
      },
      peringatan: adaPeringatan ? "Siswa dengan nama dan kelas yang sama sudah terdaftar." : null,
      pesan: "Data siswa beserta tagihan perdana berhasil diterbitkan."
    });

  } catch (error) {
    // Batalkan seluruh rangkaian jika ada kegagalan query di tengah jalan
    await koneksiTransaksi.rollback();
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  } finally {
    // Lepaskan koneksi pool kembali ke server MySQL
    koneksiTransaksi.release();
  }
});

module.exports = router;
