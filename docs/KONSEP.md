# Konsep VIN — versi yang bisa dibaca ulang

> **Asal dokumen ini.** Dokumen konsep asli (rancangan enam kontrak: `VinRegistry`, `ListingEscrow`,
> `InspectionEscrow`, `NoteNft`, `StakeVault`, `AccessController`) **tidak tersimpan di repo ini**.
> Dokumen ini adalah **rekonstruksi dari repo**: aturan yang benar-benar dikodekan, diuji, dan
> dijalankan — bukan janji baru. Bagian yang jelas berasal dari dokumen Anda ditandai
> **[konsep §N]**, sesuai bagian yang dikutip oleh kode di repo (daftar kutipan ada di §11).
> Kalau ada pertentangan antara dokumen ini dan kode, **kode yang benar**; kalau pertentangan itu
> soal niat bisnis, dokumen Anda yang benar — dan repo harus disesuaikan.

---

## 1. Masalah yang diambil

Impor kendaraan lintas negara punya tiga titik gagal yang berulang:

1. **Uang bergerak sebelum kendaraan terbukti ada.** Pembeli mengirim dana atas dasar foto.
2. **Riwayat kilometer tidak dapat dipercaya.** Angka odometer diturunkan, dan tidak ada catatan
   yang tidak bisa ditimpa.
3. **Inspeksi tidak independen.** Bengkel dipilih penjual, atau berafiliasi dengan penjual.

VIN mengambil satu irisan sempit: **kendaraan yang benar-benar berpindah tangan**, dengan inspeksi
wajib, escrow dua tahap, dan riwayat yang tidak bisa ditulis ulang.

## 2. Janji yang tidak bisa dinegosiasikan

Sepuluh aturan di bawah ini adalah inti produk. Kolom terakhir menunjukkan bahwa aturan itu bukan
niat di dokumen — ia ditegakkan mesin dan dikunci uji.

| # | Aturan | Ditegakkan di | Bukti uji |
| --- | --- | --- | --- |
| 1 | Harga kendaraan, ongkos, dan fee inspeksi dibayar dengan **stablecoin atau fiat** — token tidak pernah dipakai membayar kendaraan | `DISCLAIMERS.moneyRule`, `TOKEN_UTILITY.neverDoes` | `rules.test.ts`, koleksi `Meta` |
| 2 | **Dua escrow terpisah** (kendaraan & inspeksi); satu leg tidak bisa menyentuh leg lain | `vault-spec.ts`, dua vault on-chain | `vault.property.test.ts` (properti), uji Anchor 2 & 4 |
| 3 | **Dana hanya bergerak bila bukti ada**: setiap pelepasan membawa `evidence_hash`; serah terima wajib dikonfirmasi | `vehicleReleasePreconditions`, `inspectionReleasePreconditions` | `rules.test.ts`, uji Anchor 15, koleksi `Deals` |
| 4 | **Satu VIN → satu deal aktif** | `recordReserve` (model + on-chain) | uji Anchor 12, `onchain-rules.test.ts` |
| 5 | **Odometer memakai titik tertinggi (high-water)**: laporan lebih rendah = **peringatan**, tidak pernah menurunkan baseline dan tidak pernah menolak deal otomatis | `odometerIsAnomaly`, `recordInspection`, `max_odometer` on-chain | uji Anchor 13 & 14, `rules.test.ts`, koleksi `Regression - Odometer Baseline` |
| 6 | **Sengketa membeku.** `release_leg` **dan** `refund_leg` ditolak saat deal beku; hanya arbiter yang menyelesaikan | `require_state`/gerbang beku di `lib.rs`, `freezeDeal` | uji Anchor 6, 7, 16; `vault.property.test.ts` |
| 7 | **Jaminan yang dipotong masuk dana sengketa, bukan ke tim** | `slashBondToDisputeFund`, `slash_bond` | uji Anchor 9, `rules.test.ts` |
| 8 | **Bengkel berafiliasi dengan penjual diblokir** dari pesanan penjual itu | `INSPECTOR_CONFLICT` di API | `rules.test.ts`, koleksi `E2E Dispute Path` |
| 9 | **Nota (NFT) hanya untuk deal selesai**, dan nota itu bukti & jejak klaim — **bukan surat kepemilikan** | `canRecordNote` / `record_note` wajib state `Released` | uji Anchor 10, 11, 18; koleksi `Deals` |
| 10 | **Setiap perubahan tercatat sebagai event** dan nomor urut per VIN tidak bisa ditimpa | tabel `events` append-only, taksonomi 10 tipe | `seed.ts` (uji integrasi), `smoke.ts` |

Aturan turunan yang juga berlaku: **inspeksi wajib** di koridor pilot, akun **satu peran**
**[konsep §3]**, dan identitas bisa **dicabut** setelah pelanggaran.

## 3. Peran dan wewenang

| Peran | Boleh | Tidak boleh |
| --- | --- | --- |
| **Buyer** | Kunci deal, danai escrow, terima/tolak laporan, konfirmasi serah terima, buka sengketa | Menandai serah terima atas nama penjual |
| **Seller/dealer** | Buat listing (dengan jaminan di atas ambang nilai), tandai serah terima | Memilih bengkel inspeksi, melepas dana |
| **Inspector (bengkel)** | Unggah laporan dengan hash, punya jaminan operasional | Terima pesanan dari penjual yang berafiliasi dengannya |
| **Curator** | Verifikasi identitas bisnis, catat afiliasi, buka koridor (setelah koridor lama sehat) | Menyentuh dana |
| **Arbiter** | Memutus sengketa (refund / release / split / potong jaminan) — **pembukuan harus pas sampai nol** | Melepas dana saat deal tidak beku |
| **Relayer (kunci panas platform)** | Melepas dana **dengan bukti**, berdasarkan log event yang bisa diaudit | Mengubah tujuan fee; menerima fee |
| **Admin** | Ganti relayer/arbiter/treasury, jeda program | Memindahkan dana ke dirinya sendiri (tidak ada instruksi untuk itu) |

**Verifikasi bertingkat:** `none` → `basic` (buyer) → `business_verified` (penjual/bengkel) →
`suspended`. Di produksi, verifikasi bisnis seharusnya berupa *attestation* yang bisa dicabut
(bukan kolom biasa); di repo ini masih kolom + aksi curator manual.

## 4. Uang

- **Fee:** 1,00% untuk transaksi kendaraan; 5,00% dari fee inspeksi. Diskon fee 40% bila dibayar
  dengan token (pemakai tanpa token tetap bayar stablecoin) — angka di `policy.ts`.
- **Jaminan (stablecoin):** listing di atas ambang nilai **50 USDC**; bengkel **25 USDC** untuk
  boleh menerima pesanan. Ambang nilai koridor pilot **USD 15.000**;
  jaminan stablecoin boleh sampai **USD 30.000**, di atas itu jaminan token.
- **Pemotongan jaminan:** 50% dipotong; **seluruh bagian yang dipotong masuk dana sengketa**
  (bukan tim), sisanya kembali ke aktor **[konsep §9 / playbook]**.
- **Token punya tiga fungsi:** jaminan listing, diskon fee, akses kapasitas.
  **Tidak pernah:** membeli harga kendaraan, bagi hasil, tata kelola perusahaan.
- **Penyelesaian sengketa harus pas:** `to_buyer + to_seller == sisa leg kendaraan`;
  `to_inspector <= sisa leg inspeksi` (sisanya ke pembeli). Tidak boleh ada dana menganggur
  di vault tanpa pemilik.

## 5. Alur yang sebenarnya

**Bahagia (8 langkah):** penjual membuat listing → pembeli mengunci deal (dua escrow dibuat) →
kedua leg didanai → bengkel mengunggah laporan (hash + odometer) → pembeli menerima laporan
(dana inspeksi lepas) → penjual menandai serah terima → pembeli mengonfirmasi → dana kendaraan
lepas, nota dicatat. Setiap langkah menulis event.

**Tenggat [konsep §3]:** kalau tidak ada yang menerima/menolak laporan dalam waktu yang
ditentukan, dana inspeksi tetap boleh lepas **asalkan laporan memenuhi standar** — bukan
diam-diam lepas. Jendela konfirmasi on-chain saat ini 72 jam, dan pelepasan dana kendaraan
dimungkinkan setelah jendela itu lewat tanpa sengketa.

**Sengketa:** pembeli (atau pihak dalam deal) membekukan deal → dana dan nota beku → arbiter
memutus dengan pembukuan pas → jaminan yang bersalah dipotong ke dana sengketa.

**Pembatalan:** sebelum dana masuk, deal bisa dibatalkan. Refund oleh relayer saat deal beku
**ditolak** (aturan 6) — inilah regresi yang tertangkap CI dan diperbaiki di `21d8c41`.

## 6. Tahap publikasi dan gate

| Tahap | Isi | Dilarang |
| --- | --- | --- |
| **Proof** (sekarang) | satu koridor, inspeksi & escrow wajib, riwayat VIN menyala, nota hanya untuk deal selesai, jaminan stablecoin | penjualan token ke publik, proyeksi harga |
| **Market** | bengkel pihak ketiga mendaftar sendiri, standar laporan ditegakkan, metrik publik | proyeksi harga |
| **Token** | jaminan token, diskon fee, akses kapasitas | hak atas pendapatan, janji imbal hasil |
| **Expansion** | koridor kedua, bengkel lokal terverifikasi | melemahkan aturan anomali odometer secara surut |

**Gate bisnis (ROADMAP):** ≥ 20 deal selesai, sengketa ≤ 10%, tidak ada anomali kilometer tanpa
penjelasan, ≥ 30% penjual & bengkel kembali. **Parameter halt di kode** saat ini lebih longgar
(2 deal, 15%, 3 anomali, 30%) karena itu nilai prototipe agar dasbor bisa diuji; gate bisnis tetap
yang berlaku untuk keputusan perluasan koridor.

## 7. Batas klaim — yang tidak boleh pernah dikatakan

1. **VIN di platform bukan VIN registrasi resmi.** Keunikan di platform ≠ keunikan di registri
   resmi; format sasis antarnegara berbeda.
2. **NFT nota bukan surat kepemilikan (title).** Ia bukti dan jejak klaim. STNK, BPKB, bea cukai,
   pajak, dan balik nama mengikuti hukum negara asal dan tujuan.
3. **Laporan inspeksi bukan garansi.** Ia temuan pada tanggal inspeksi, bukan jaminan sampai
   kendaraan tiba.
4. **Token bukan ekuitas**, tanpa bagi hasil, tanpa hak suara atas pendapatan perusahaan, dan
   tidak dipakai membeli harga kendaraan.
5. **Tidak ada proyeksi harga token** dan tidak ada penjualan publik sebelum tahap Token.
6. **Kripto bukan alat pembayaran yang sah di Indonesia**; rupiah tetap alat bayar sah. Karena itu
   VIN tidak pernah memakai token untuk pembayaran ke pihak luar.
7. **Belum di-deploy, belum diaudit, belum ada uang nyata.** Program Anchor belum pernah
   dideploy (`declare_id!` masih placeholder), escrow yang jalan masih `MockEscrowProvider`.
   Audit pihak ketiga dan multisig (mis. Squads) adalah **prasyarat** sebelum dana nyata.

## 8. Status nyata hari ini

**Sudah jalan dan diuji** (angka dari commit terakhir; semuanya bisa direproduksi):

- **63 uji unit** (`npm test`): 11 aturan inti + 11 properti ledger + 19 aturan on-chain
  (termasuk uji properti) + 14 SIWS + 5 penyimpanan bukti + 3 penjaga regresi.
- **17 uji Anchor hijau di CI** (`anchor build` + gerbang frame SBF + `anchor test`), plus
  **160/160 asersi koleksi Postman** dari seed bersih.
- **Autentikasi SIWS nyata**: nonce sekali pakai, verifikasi ed25519, token sesi (hash sha256),
  cookie httpOnly, rate limiting, sign-out mencabut token. Header `x-actor-id` hanya demo.
- **Bukti content-addressed**: `POST /api/evidence` (whitelist tipe, batas 10 MB), hash otomatis,
  cache privat.
- **Seed berfungsi sebagai uji integrasi** alur penuh + kasus anomali odometer yang berakhir sengketa.

**Belum ada** (jangan diklaim ada):

- Program **belum dideploy** ke cluster mana pun; `AnchorEscrowProvider` di API masih stub.
- **Postgres** (SQLite sekarang), **antrean pekerjaan asinkron**, **mint NFT nota**
  (`noteAssetId: null`), **mitra escrow berizin**, **KYB vendor**, **audit**, **login sosial**
  (butuh kredensial OAuth + embedded wallet).
- `GET /api/evidence/:hash` masih tanpa gerbang identitas: hash berperan sebagai kunci. Untuk foto
  listing itu memang perlu publik; untuk dokumen yang memuat data pribadi, perlu model akses lain.
- `refund_leg` belum dibatasi state: refund setelah `HandoverConfirmed` masih mungkin.

## 9. Peta dokumen

| Kalau Anda ingin tahu… | Baca |
| --- | --- |
| **Perbandingan konsep Anda (6 kontrak) vs program sekarang** | `docs/SPEC_RECONCILIATION.md` |
| Alur on-chain langkah demi langkah, siapa menandatangani apa | `docs/FLOW.md` |
| Arsitektur, model data, aliran uang | `docs/ARCHITECTURE.md` |
| Referensi program Anchor: akun, instruksi, invarian | `docs/PROGRAM.md` |
| Tahap, gate, checklist mainnet | `docs/ROADMAP.md` |
| Autentikasi (SIWS) apa adanya | `docs/SIWS.md` |
| Referensi endpoint API | `docs/API.md` |
| Spesifikasi Fase 1 + regresi yang tertangkap CI | `docs/FASE1_ANCHOR.md` |
| Batas hukum dan yang tidak boleh dipublikasikan | `docs/LEGAL.md` |
| Cara menjalankan build/test di mesin sendiri | `docs/LOCAL_TEST.md` |
| Pilihan teknologi + jawaban Rust/Go | `docs/TECH_STACK.md` |
| Deployment & kesiapan uang nyata | `docs/DEPLOYMENT.md` |
| Koleksi Postman | `docs/COLLECTION.md` |

## 10. Keputusan terbuka (butuh pemilik, bukan agen)

1. **Yurisdiksi & izin per koridor.** Koridor pilot sekarang **AE → KE**; analisis hukum di
   `docs/LEGAL.md` disusun untuk entitas Indonesia, jadi izin lintas-negara harus dicek ulang.
2. **Mitra escrow berizin** di koridor (rekening bersama/PJP) + jalur fiat on/off-ramp.
3. **Penyedia KYB** untuk penjual & bengkel, plus SOP pencabutan identitas.
4. **SOP sengketa tertulis**: siapa arbiter, batas waktu, bukti yang diterima.
5. **Model akses bukti:** mana yang publik, mana yang harus terautentikasi.
6. **Aturan refund per state** (celah §8) dan test-nya.
7. **Kapan beralih ke enam kontrak** — rekomendasi repo: adopsi bertahap, jangan tulis ulang
   (lihat `docs/SPEC_RECONCILIATION.md` §5).

## 11. Kutipan ke dokumen konsep Anda

Kode dan dokumen repo mengutip bagian-bagian ini; itulah jejak dokumen asli yang masih tersimpan:

| Kutipan | Di mana |
| --- | --- |
| `concept §2` — afiliasi penjual↔bengkel diblokir | `services/api/src/routes/actors.ts:163` |
| `concept §3` — akun memisahkan peran; tenggat laporan | `packages/shared/src/types.ts:22`, `packages/shared/src/state.ts:37` |
| `concept §3 and §4` — jumlah item minimum laporan | `packages/shared/src/schema.ts:103` |
| `concept §9` — yang tidak boleh dipublikasikan | `docs/LEGAL.md:72` |
| `dokumen konsep §10` — empat angka yang menentukan | `docs/TECH_STACK.md:142` |
| Rancangan enam kontrak | `docs/SPEC_RECONCILIATION.md:3` |

> **Saran:** simpan dokumen konsep aslinya di repo (mis. `docs/KONSEP_ASLI.md`). Selama belum ada,
> setiap rujukan "concept §N" tidak bisa diverifikasi pembaca lain, dan dokumen ini hanya bisa
> merekonstruksi — bukan menggantikan.
