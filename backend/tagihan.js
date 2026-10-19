const express = require('express');
const db = require('./db');
const { kunciBendahara } = require('./auth');

const router = express.Router();

// LINGKUNGAN ATURAN BISNIS: FUNGSI GLOBAL SINKRONISASI TAGIHAN (IDEMPOTENT)
async function jalankanSinkronisasiTagihan() {
  const koneksiTransaksi = await db.getConnection();
  await koneksiTransaksi.beginTransaction();

  try {
    // Ambil tahun-bulan berjalan saat ini di zona waktu WIB (Format: YYYY-MM)
    const hariIni = new Date();
    const bulanSekarangStr = hariIni.toLocaleString("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" });
    const [tahunSkg, bulanSkg] = bulanSekarangStr.split('/');
    const bulanBerjalan = `${tahunSkg}-${bulanSkg}`; // Hasil akhir: "2026-10"

    // 1. Ambil daftar semua siswa aktif yang belum dihapus beserta biaya golongan SPP mereka
    const [daftarSiswa] = await koneksiTransaksi.query(`
      SELECT s.id AS siswa_id, s.bulan_mulai_tagih,
             spp_b.id AS spp_bulanan_id, spp_b.biaya AS biaya_bulanan,
             spp_t.id AS spp_tahunan_id, spp_t.biaya AS biaya_tahunan
      FROM siswa s
      JOIN spp spp_b ON s.spp_bulanan_id = spp_b.id
      JOIN spp spp_t ON s.spp_tahunan_id = spp_t.id
      WHERE s.status = 'aktif' AND s.deleted_at IS NULL
    `);

    let jumlahTagihanDibuat = 0;
    let siswaTerdampakSet = new Set();
    let bulanDiprosesSet = new Set();

    // 2. Lakukan looping untuk setiap siswa
    for (const siswa of daftarSiswa) {
      const { siswa_id, bulan_mulai_tagih, spp_bulanan_id, biaya_bulanan, spp_tahunan_id, biaya_tahunan } = siswa;

      // Buat pointer tanggal dari bulan_mulai_tagih sampai bulan berjalan saat ini
      let tanggalPointer = new Date(`${bulan_mulai_tagih.substring(0, 7)}-02`); // Hindari error zona waktu dengan tanggal 2
      let tanggalAkhir = new Date(`${bulanBerjalan}-02`);

      while (tanggalPointer <= tanggalAkhir) {
        const tahunPointer = tanggalPointer.getFullYear();
        const bulanPointer = String(tanggalPointer.getMonth() + 1).padStart(2, '0');
        const loopBulanTahun = `${tahunPointer}-${bulanPointer}`; // Format: "2026-07"
        const loopTanggalLengkap = `${loopBulanTahun}-01`;

        bulanDiprosesSet.add(loopBulanTahun);

        // ==========================================
        // GENERATE TAGIHAN BULANAN RUTIN
        // ==========================================
        const [cekBulanan] = await koneksiTransaksi.query(
          "SELECT id FROM tagihan WHERE siswa_id = ? AND jenis = 'bulanan' AND bulan = ?",
          [siswa_id, loopTanggalLengkap]
        );

        if (cekBulanan.length === 0) {
          // Hitung sisa saldo / deposit dari pembayaran bulan-bulan lalu secara real-time (Agregasi FIFO)
          const [[kalkulasiBulanan]] = await koneksiTransaksi.query(`
            SELECT 
              COALESCE((SELECT SUM(nominal) FROM tagihan WHERE siswa_id = ? AND jenis = 'bulanan' AND deleted_at IS NULL), 0) AS total_tagihan,
              COALESCE((SELECT SUM(nominal) FROM pembayaran WHERE siswa_id = ? AND jenis = 'bulanan' AND deleted_at IS NULL), 0) AS total_dibayar
          `, [siswa_id, siswa_id]);

          const saldoLebihBulanLalu = Math.max(kalkulasiBulanan.total_dibayar - kalkulasiBulanan.total_tagihan, 0);

          // Terbitkan lembar tagihan bulanan baru (Bekukan nominal tarif)
          const [resTagihan] = await koneksiTransaksi.query(
            `INSERT INTO tagihan (siswa_id, jenis, bulan, nominal, spp_id) VALUES (?, 'bulanan', ?, ?, ?)`,
            [siswa_id, loopTanggalLengkap, biaya_bulanan, spp_bulanan_id]
          );
          jumlahTagihanDibuat++;
          siswaTerdampakSet.add(siswa_id);

          // LOGIKA OTOMATIS SALDO DEPOSIT: Jika siswa punya kelebihan bayar, potong otomatis saat tagihan lahir
          if (saldoLebihBulanLalu > 0) {
            const nominalPotongan = Math.min(saldoLebihBulanLalu, biaya_bulanan);
            const idTagihanBaru = resTagihan.insertId;
            const tanggalHariIni = new Date().toISOString().slice(0, 10);

            await koneksiTransaksi.query(
              `INSERT INTO pembayaran (siswa_id, jenis, tanggal, nominal, catatan, sumber) 
               VALUES (?, 'bulanan', ?, ?, 'Dipotong otomatis dari kelebihan saldo deposit bulan lalu', 'normal')`,
              [siswa_id, tanggalHariIni, nominalPotongan]
            );
          }
        }

        // ==========================================
        // GENERATE TAGIHAN TAHUNAN (KHUSUS BULAN JULI)
        // ==========================================
        if (bulanPointer === '07') {
          const [cekTahunan] = await koneksiTransaksi.query(
            "SELECT id FROM tagihan WHERE siswa_id = ? AND jenis = 'tahunan' AND bulan = ?",
            [siswa_id, loopTanggalLengkap]
          );

          if (cekTahunan.length === 0) {
            // Terbitkan tagihan tahunan kurikulum baru
            await koneksiTransaksi.query(
              `INSERT INTO tagihan (siswa_id, jenis, bulan, nominal, spp_id) VALUES (?, 'tahunan', ?, ?, ?)`,
              [siswa_id, loopTanggalLengkap, biaya_tahunan, spp_tahunan_id]
            );
            jumlahTagihanDibuat++;
            siswaTerdampakSet.add(siswa_id);
          }
        }

        // Geser pointer naik 1 bulan ke depan
        tanggalPointer.setMonth(tanggalPointer.getMonth() + 1);
      }
    }

    await koneksiTransaksi.commit();
    return {
      dibuat: jumlahTagihanDibuat,
      siswa_terdampak: siswaTerdampakSet.size,
      bulan_diproses: Array.from(bulanDiprosesSet)
    };

  } catch (error) {
    await koneksiTransaksi.rollback();
    throw error;
  } finally {
    koneksiTransaksi.release();
  }
}

// 3. ENDPOINT MANUAL TRIGGER SINKRONISASI (POST /api/tagihan/sinkron)
router.post('/sinkron', kunciBendahara, async (req, res) => {
  try {
    const hasil = await jalankanSinkronisasiTagihan();
    res.json(hasil);
  } catch (error) {
    res.status(500).json({ error: { kode: "SERVER_ERROR", pesan: error.message } });
  }
});

module.exports = { tagihanRouter: router, jalankanSinkronisasiTagihan };
