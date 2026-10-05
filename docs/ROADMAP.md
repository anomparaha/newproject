# Roadmap VIN — tahap, gate, dan checklist peluncuran

Setiap tahap punya **gate**: angka yang harus benar sebelum lanjut. Gate tidak bisa dilewati dengan
menambah fitur atau menambah utilitas token.

---

## Tahap 0 — Fondasi (repo ini)

**Sudah ada**

- [x] Domain bersama: tipe, taksonomi 10 event, state machine, aritmetika uang desimal.
- [x] API: aktor, koridor, listing, deal, escrow dua leg, laporan, anomali, serah terima, nota, sengketa, reputasi.
- [x] Frontend: dasbor, listing, konsol deal, halaman VIN, pasar inspeksi, koridor, kebijakan.
- [x] Event log append-only dengan nomor urut per VIN.
- [x] 11 uji aturan inti + seed yang berfungsi sebagai uji integrasi alur penuh.
- [x] Program Anchor (belum dikompilasi): escrow dua vault, jaminan, arbiter, registri nota.
      Uji siap-jalan + temuan review: `docs/PROGRAM.md`. Perbandingan dengan rancangan
      lima-kontrak + urutan adopsi: `docs/SPEC_RECONCILIATION.md`.

**Belum ada**

- [ ] Postgres + migrasi (skema sudah portabel).
- [x] Autentikasi Sign-In With Solana (SIWS) — nonce sekali pakai, verifikasi ed25519, token sesi
      (hash sha256), sign-out mencabut token. Header `x-actor-id` hanya untuk demo dan mati saat
      `VIN_DEMO_MODE=false`. Lihat `docs/SIWS.md`. Rate limiting (sliding-window per IP+wallet pada
      `/auth/challenge` dan `/auth/verify`, 429 + `Retry-After`) dan cookie sesi httpOnly
      (`vin_session`, SameSite=Lax, Secure di prod) sudah ada. **Sisa:** embedded wallet untuk login sosial.
- [ ] Antrean pekerjaan asinkron (email/WhatsApp, penarikan dana, rekonsiliasi).
- [ ] Unggah berkas bukti ke object storage + penyimpanan hash otomatis.

---

## Tahap 1 — Tahap Bukti (satu koridor)

**Tujuan:** membuktikan kendaraan fisik benar-benar selesai, bukan membuktikan tokennya laku.

Lingkup: satu koridor (mis. ID → SG), inspeksi wajib, escrow wajib, riwayat VIN menyala,
NFT nota hanya untuk deal selesai, **belum ada penjualan token ke publik**, jaminan dalam stablecoin.

Pekerjaan:

- [ ] Mitra escrow berizin di koridor (rekening bersama/PJP) + alur fiat on/off-ramp.
- [ ] KYB penjual dan bengkel; SOP pencabutan identitas.
- [ ] 3–5 bengkel terverifikasi dengan jaminan kapasitas.
- [ ] SOP sengketa tertulis: siapa arbiter, batas waktu, bukti yang diterima.
- [ ] Dokumen hukum: syarat listing, syarat inspeksi, kebijakan privasi (UU PDP), perjanjian pengguna.
- [ ] Monitoring: p95 latensi endpoint deal, tingkat kegagalan webhook, antrean sengketa.

**Gate lanjut ke Tahap 2**

- ≥ 20 deal selesai, dan
- tingkat sengketa ≤ 10%, dan
- tidak ada anomali kilometer yang dibiarkan tanpa penjelasan, dan
- ≥ 30% penjual dan bengkel kembali untuk deal kedua.

---

## Tahap 2 — Tahap Pasar

**Tujuan:** pasar inspeksi berjalan tanpa platform menggaji inspektor.

- [ ] Bengkel pihak ketiga mendaftar mandiri; standar laporan `vin-report-v1` ditegakkan ketat.
- [ ] Pembekuan sengketa otomatis; reputasi publik dihitung dari event.
- [ ] Metrik publik ditampilkan apa adanya: deal selesai, waktu median sampai laporan, tingkat sengketa.
- [ ] Kurator koridor: verifikasi, afiliasi, dan spot-check inspeksi acak.
- [ ] Halaman VIN terindeks mesin pencari (SEO) + tombol "klaim unit ini sebagai penjual".

**Gate lanjut ke Tahap 3**

- ≥ 100 deal selesai, tingkat sengketa ≤ 8%, median waktu sampai laporan ≤ 72 jam,
- dan ada penjual/bengkel yang benar-benar meminta mekanisme jaminan yang lebih kuat
  (bukan permintaan dari tim token).

---

## Tahap 3 — Tahap Token

**Aturan yang tidak bisa dinegosiasikan:** token terbit **hanya setelah** ada pemakaian nyata yang
membutuhkannya. Tidak ada alokasi yang dibingkai sebagai hak atas pendapatan.

- [ ] Program Anchor diaudit (minimal satu firma independen) sebelum dana nyata.
- [ ] Multisig (Squads) untuk admin; relayer tidak boleh menyentuh jaminan.
- [ ] Struktur token: jaminan listing, jaminan bengkel, potongan fee, kapasitas.
      Tanpa bagi hasil, tanpa hak suara atas pendapatan, tanpa janji harga.
- [ ] Bakar token hanya dari fee yang benar-benar terkumpul dari pemakaian. Tidak ada jadwal bakar.
- [ ] Publikasi: cara kerja pasar, batas hukum NFT, alur escrow, data koridor.
      **Tidak** dipublikasikan sebagai fakta: proyeksi harga token atau janji hasil untuk holder.
- [ ] Pendapat hukum dan kepatuhan pajak di yurisdiksi yang dilayani (lihat `LEGAL.md`).

**Gate lanjut ke Tahap 4**

- Keempat angka di Tahap 1 tetap sehat selama dua kuartal berturut-turut.

---

## Tahap 4 — Perluasan

- [ ] Koridor kedua dengan bengkel lokal terverifikasi.
- [ ] Riwayat VIN lama tetap terbaca (tidak ada reset data saat menambah koridor).
- [ ] Aturan anomali kilometer **tidak diubah mundur**: perubahan aturan harus tercatat sebagai event baru.

---

## Checklist sebelum uang nyata bergerak

**Hukum & kepatuhan**

- [ ] Sesuai kerangka OJK untuk aset kripto/aset keuangan digital (POJK 27/2024 jo. POJK 23/2025) —
      termasuk kewajiban memperoleh izin bila menjalankan kegiatan penyelenggara.
- [ ] Menyelesaikan pemetaan pajak transaksi aset kripto (PMK 50/2025) dan kewajiban pelaporan.
- [ ] Tidak menggunakan kripto sebagai alat pembayaran yang sah di Indonesia (rupiah tetap satu-satunya
      alat pembayaran sah; hal ini juga ditegaskan oleh BI).
- [ ] Kebijakan privasi dan pemrosesan data sesuai UU PDP: tidak ada data pribadi on-chain.
- [ ] Perjanjian pengguna memuat batas: NFT nota bukan surat kendaraan dan tidak memindahkan kepemilikan hukum.

**Teknis**

- [ ] Audit program Anchor + perbaikan temuan.
- [ ] Uji properti/fuzzing untuk aritmetika vault dan batas pelepasan.
- [ ] Multisig + timelock untuk perubahan konfigurasi program; batas harian pelepasan dana.
- [ ] Simulasi skenario: relayer dicuri, RPC mati, program di-upgrade paksa, sengketa massal.
- [ ] Rekonsiliasi harian antara event log, escrow provider, dan saldo on-chain.
- [ ] Rencana pemulihan bencana: cadangan basis data, prosedur pembekuan darurat, jalur komunikasi pengguna.

**Operasional**

- [ ] SOP sengketa + daftar arbiter dengan konflik kepentingan yang diumumkan.
- [ ] Dukungan pengguna dua bahasa di koridor.
- [ ] Transparansi: halaman metrik koridor diperbarui otomatis dari data, bukan ditulis manual.
