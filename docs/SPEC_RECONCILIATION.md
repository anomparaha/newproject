# Rekonsiliasi Spesifikasi: Alur Rancangan Lima-Kontrak vs Implementasi Program

Dokumen ini membandingkan **spesifikasi alur yang Anda tulis** (enam kontrak terpisah: `VinRegistry`, `ListingEscrow`, `InspectionEscrow`, `NoteNft`, `StakeVault`, `AccessController`) dengan **program Anchor yang ada di repo ini** (`programs/vin-anchor/src/lib.rs`, 14 instruksi) beserta model aturan yang sudah diuji.

> Status kejujuran: spesifikasi Anda adalah **rancangan**, bukan kode produksi dan bukan opini hukum. Program di repo ini **belum pernah dikompilasi** (`anchor build` belum jalan di lingkungan ini); yang sudah benar-benar dijalankan dan diuji adalah **model aturan TypeScript** di `packages/shared`. Karena itu perbandingan ini disusun sebagai *perbedaan desain + rekomendasi*, bukan klaim bahwa salah satu sisi sudah siap mainnet.

Ringkasan singkat: **spesifikasi Anda lebih kuat sebagai target arsitektur** (pengaman peran berbasis waktu, pemisahan fee, registry event-first, jendela konfirmasi serah-terima). **Program sekarang lebih kuat pada pembukuan** (penyelesaian sengketa exact-accounting + 22 uji properti sebagai bukti eksekusi). Rekomendasi: **adopsi bertahap 4 fase** — jangan tulis ulang dari nol.

---

## 1. Perbedaan Alur (lengkap, 18 baris)

| # | Area | Spesifikasi yang Anda berikan | Implementasi di repo sekarang | Dampak |
|---|---|---|---|---|
| 1 | **Jumlah kontrak** | 6 kontrak terpisah, registry di tengah | 1 program monolitik, 14 instruksi | Isolasi kegagalan & audit lebih mudah di 6 kontrak; monolitik lebih cepat jalan dan tidak butuh CPI antar-program (CPI antar-program Solana menambah kompleksitas dan permukaan bug) |
| 2 | **Peran & waktu** | `AccessController`: `OPERATOR`, `ARBITER`, `PAUSER`, `UPGRADER` **berbasis waktu** (kedaluwarsa) | 1 `config.admin` tunggal, tanpa masa berlaku | Spesifikasi Anda jauh lebih baik: rotasi kunci otomatis, hak akses tidak abadi |
| 3 | **Pause** | `PAUSER` hanya bisa menghentikan `deposit`/`release`/`mintNote`, **tidak boleh menulis ulang registry** | `config.paused` satu saklar yang memblokir lebih luas | Peran PAUSER yang sempit = risiko penyalahgunaan jauh lebih kecil |
| 4 | **Arbitrase** | Bukan satu kunci: 2-dari-3 penandatangan atau modul arbitrase terdaftar | `config.arbiter` satu kunci (bisa multiprisig di luar chain) | 2-dari-3 lebih kuat; versi sekarang hanya sekuat disiplin pengelola kunci |
| 5 | **Dana fee** | **Tidak pernah** dikirim ke dompet tim dalam transaksi yang sama: masuk `FeeCollector`, penarikan/pembakaran terpisah dan dibatasi peran | `config.fee_treasury` dipatok di config (bukan dipilih relayer), tetapi dana tetap mengalir ke satu alamat saat `release` | Pemisahan `FeeCollector` memindahkan "titik pencurian" dari jalur dana pembeli ke satu kontrak kecil — lebih mudah diaudit |
| 6 | **Pembakaran token** | Hanya dari fee yang sudah terkumpul | Belum ada konsep fee terkumpul/pembakaran | Menunggu tahap Token; jangan diimplementasikan sebelum ada fee nyata |
| 7 | **Urutan pemanggilan** | Rantai `lock bond → recordListing → createDeal+deposit → fundInspection → submitReport → acceptReport → markHandover → confirmHandover → release+mintNote`, di luar urutan **harus revert** | Tidak ada state machine tunggal: `open_deal` bisa dibuka kapan saja selama ada escrow; urutan sebagian dijaga `require!` (46+ penjagaan) tetapi tidak menyeluruh | **Celah nyata yang sudah ditutup di model**: `applyCall()` sekarang menegakkan seluruh tabel urutan (lihat `docs/FLOW.md` §8 dan `onchain-rules.ts`) |
| 8 | **Invarian one-listing-one-deal** | `createDeal` mengubah listing → `reserved` dan menolak deal kedua untuk listing yang sama | `open_deal` memakai seeds `[deal, vin_hash, buyer]` → **dua pembeli bisa membuka dua deal paralel untuk satu VIN** | Bug paling berbahaya di luar chain: kurang bayar/kompensasi tak sengaja. Diperbaiki di model + perbaikan Rust |
| 9 | **Odometer** | Dihitung **di dalam kontrak** dari event terakhir; wajib ditandai sebelum pembeli boleh menerima | API memakai `maxOdometer` (titik tertinggi) + wajib acknowledge; on-chain belum ada | Anomali bisa disembunyikan bila server/relayer tidak jujur. Sudah dikodekan di model (`recordInspection`) dan di API sejak perbaikan `maxOdometer` |
| 10 | **Dasar pembanding odometer** | "Event terakhir" | Model hasil rekonsiliasi memakai **`maxOdometer`** (titik tertinggi), bukan angka terakhir | Dengan "angka terakhir", satu laporan rendah mereset dasar dan anomali berikutnya hilang. Titik tertinggi memperbaiki ini (uji properti 250 kasus) |
| 11 | **Reserve VIN** | `recordReserve` menahan VIN by dealId | Tidak ada penahanan; VIN bisa dijual berkali-kali | Harus ada di Rust sebelum mainnet |
| 12 | **Jendela konfirmasi** | `markHandover` (penjual saja) → jendela waktu pembeli untuk `confirmHandover` atau `openDispute` → `release` hanya bila syarat terpenuhi dan tak ada sengketa aktif; `refund` saat deadline/keputusan | `release_leg` dapat dipanggil relayer setelah leg penuh; tidak ada jendela, tidak ada deadline, tidak ada auto-refund | Terbaik dari kedua sisi: jendela + deadline mencegah dua kegagalan (pembeli menahan dana selamanya; dana tersangkut saat pembeli hilang) |
| 13 | **Pemilik kunci rilis** | Backend **tidak memegang kunci rilis**; `release` dapat dipanggil siapa pun setelah syarat terbukti | `release_leg`/`refund_leg` dijalankan **relayer** dengan hak istimewa | Menghapus "hot key platform" adalah perbaikan keamanan nyata (bukan sekadar preferensi) |
| 14 | **Refund terstruktur** | `refund` saat deadline lewat atau putusan | `refund_leg` ada, tetapi tanpa deadline dan tanpa jaminan invarial "tidak ada sengketa aktif" | Menambah deadline + penjagaan sengketa mencegah kebuntuan |
| 15 | **Fee inspeksi** | `acceptReport` membayar bengkel **minus fee aplikasi**; `rejectReport` dibekukan (dana tidak kembali otomatis) | Model exact-accounting: bengkel dibayar penuh bila pekerjaan sudah dikerjakan, sisa dikembalikan ke pembeli; pembekuan tidak otomatis mengembalikan | Pembukuan lama lebih eksak (dana tidak pernah tersangkut) — ini yang harus DIPERTAHANKAN |
| 16 | **Sengketa** | `recordDispute`/`recordResolution` di registry; eskrow hanya membaca hasil | `resolve_dispute` di program yang sama, menetapkan dua leg persis nol (debit = kredit), membayar bengkel bila pekerjaan sudah dikerjakan | Bila registry dipisah, penyelesaian harus tetap **exact-accounting** dan tidak boleh mengandalkan satu pihak |
| 17 | **Nota** | Mint **hanya oleh `ListingEscrow` setelah `release`**; transfer boleh dinonaktifkan; halaman menyatakan bukan bukti kepemilikan | `record_note` dipanggil setelah `deal.completed \|\| cancelled`, memakai `init` (tidak bisa ditimpa) | Sama-sama append-only; pembatasan pemanggil (kontrak vs wallet) adalah pengerasan yang benar |
| 18 | **Bond** | `lock(role, amount)`; eskrow hanya **membaca** apakah saldo terkunci cukup; `slash` **hanya** dari modul sengketa setelah putusan; `unlock` hanya bila tak ada kasus terbuka; **tidak ada fungsi yang memindahkan bond ke tim tanpa caseId** | `lock_bond`, `slash_bond` (arbiter), `unlock_bond`; pemotongan masuk **dana sengketa**, bukan tim | Spesifikasi Anda menambahkan "tanpa caseId" sebagai aturan tata kelola — layak diadopsi apa adanya |
| 19 | **kybHash** | Satu `kybHash` + status lulus per pelaku, ditulis operator | Ada model reputasi/aktor, belum ada atestasi KYB on-chain | Gunakan Solana Attestation Service (SAS) agar bisa dicabut, bukan menulis status di program |
| 20 | **Data off-chain** | Hanya hash on-chain; foto/laporan/identitas dokumen tidak pernah masuk chain | Sudah konsisten: `contentHash`/`reportHash` saja | Sama — tidak ada perbedaan |

## 2. Dua Bug Logika yang Paling Penting

Ditulis khusus karena keduanya **tidak akan terlihat di uji integrasi biasa** dan sudah masuk uji properti:

1. **Dua deal paralel untuk satu VIN** (baris 8). Seeds `[deal, vin_hash, buyer]` mengizinkan pembeli berbeda membuka deal untuk VIN yang sama. Konsekuensi: kompensasi berlebih/berkurang, dan status listing tidak pernah dikunci. Perbaikan: registry menyimpan `reservedByDeal`, dan `recordReserve` menolak deal kedua.
2. **Dasar odometer yang bisa direset** (baris 9–10). Jika kontrak hanya menyimpan pembacaan terakhir, laporan curang yang rendah **menurunkan** dasar pembanding sehingga anomali berikutnya lenyap. Perbaikan: simpan `maxOdometer` dan bandingkan semua laporan terhadapnya; `lastOdometer` hanya untuk tampilan.

## 3. Penilaian per Area (yang mana lebih baik)

| Area | Lebih baik di | Alasan singkat |
|---|---|---|
| Tata kelola peran | **Spesifikasi Anda** | Peran berbasis waktu + PAUSER sempit + UPGRADER terpisah, 2-dari-3 arbitrase |
| Aliran dana fee | **Spesifikasi Anda** | `FeeCollector` memisahkan fee dari jalur dana pembeli; penarikan/pembakaran terpisah |
| Urutan & status | **Spesifikasi Anda** (sekarang juga di repo) | State machine tunggal mencegah eksekusi di luar urutan |
| Registry & anti-dobel VIN | **Spesifikasi Anda** | Event-first + penahanan VIN; melindungi dari double-deal |
| Odometer | **Spesifikasi Anda** (dengan `maxOdometer`) | Penghitungan on-chain tidak bergantung pada kejujuran server |
| Serah-terima | **Spesifikasi Anda** | Jendela + deadline + "tanpa sengketa" menutup dua mode kebututan |
| Kepemilikan kunci rilis | **Spesifikasi Anda** | Tanpa hot key platform; `release` permissionless |
| Penyelesaian sengketa | **Implementasi repo** | Exact-accounting, teruji properti, membayar bengkel yang benar-benar bekerja |
| Pemisahan kontrak | **Implementasi repo** (jangka pendek) / **Spesifikasi** (jangka panjang) | Monolitik tanpa CPI lebih cepat dan lebih sedikit bug; 6 kontrak lebih mudah diaudit tapi lebih mahal |
| Bisa diuji sekarang | **Implementasi repo** | 41 uji di `npm test`; Rust belum pernah dikompilasi |

## 4. Yang Belum Ada di Kedua Sisi (harus diputuskan sebelum mainnet)

1. **Audit & tinjauan kepatuhan per koridor** — wajib; ini bukan pekerjaan satu kali.
2. **Penyedia KYB per negara** — spesifikasi menunjuk penyedia per koridor; repo belum memilih. Arah yang disarankan: SAS (atestasi bisa dicabut) + penyedia (Sumsub/Civic) untuk penerbitan.
3. **Penyedia fiat/escrow berlisensi** — webhook harus memverifikasi jumlah + referensi sebelum memanggil `deposit`; backend tidak boleh memegang kunci rilis.
4. **Penghubung audit↔on-chain** — bagaimana hasil audit menaut ke hash kode yang di-deploy (reproducible build) belum didefinisikan.
5. **Kemutabelan registry** — daftar instruksi Anda tidak memuat `recordReserve`/`acknowledgeAnomaly` yang menyelesaikan penahanan & pengakuan anomali; keduanya perlu ditambahkan agar tidak ada cabang buntu.
6. **Batas biaya on-chain** — 6 kontrak × CPI × penulisan event per VIN menaikkan biaya; perlu pengukuran compute unit sebelum janji "per event rendah".

## 5. Rekomendasi & Urutan Adopsi

**Jangan tulis ulang dari nol.** Ambil pengaman spesifikasi Anda, pertahankan pembukuan repo ini.

| Fase | Isi | Alasan |
|---|---|---|
| **Fase 0 — sekarang** | Model aturan sudah dikodekan: urutan wajib, `maxOdometer`, one-VIN-one-deal, sengketa membekukan alur, jendela konfirmasi (19 uji baru, total 41 lulus) | Murah, cepat, dan mengunci perilaku sebelum menyentuh Rust |
| **Fase 1 — sebelum devnet** | Terjemahkan model ke Anchor dalam satu program: `DealState` eksplisit, registry VIN di program, penolakan double-deal, gerbang `maxOdometer`, `openDispute`/`resolve` dengan exact-accounting, `record_note` setelah `released` | Satu program = paling sedikit CPI; perilaku sudah terkunci uji |
| **Fase 2 — sebelum mainnet** | Pecah menjadi kontrak terpisah bila audit menuntut: `StakeVault` dulu (paling sedikit saling ketergantungan), lalu `AccessController` (peran berbasis waktu + PAUSER sempit), terakhir `VinRegistry` | Memisahkan yang paling mudah dipisah lebih dahulu |
| **Fase 3 — pasca fee nyata** | `FeeCollector` + pembakaran hanya dari fee terkumpul | Jangan bangun infrastruktur token sebelum ada aliran fee |

**Yang wajib dipertahankan dari repo ini:** penyelesaian sengketa exact-accounting (dana selalu nol di akhir), uji properti sebagai bukti (bukan hanya daftar fitur), `record_note` memakai `init` (tidak bisa ditimpa), dan `fee_treasury` dipatok di config (bukan pilihan relayer).

## 6. Peta Kode

| Berkas | Isi |
|---|---|
| `packages/shared/src/onchain-rules.ts` | Model eksekusi: `STAGE`, `DEAL_ORDER`, `applyCall`, `canRelease`, registry `recordInspection`/`acknowledgeAnomaly` (anomali dihitung di dalam model) |
| `packages/shared/tests/onchain-rules.test.ts` | 19 uji: urutan (termasuk properti), aktor salah, sengketa membekukan, jendela konfirmasi (properti), one-VIN-one-deal, `maxOdometer` tidak bisa direset (properti), append-only (properti) |
| `programs/vin-anchor/src/lib.rs` | Program Anchor 14 instruksi — target terjemahan Fase 1 |
| `docs/FLOW.md` | Alur program yang ada saat ini, langkah demi langkah |
| `docs/PROGRAM.md` | Referensi akun/PDA/invarian/46+ penjagaan program |
