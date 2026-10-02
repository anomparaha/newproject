# Pilihan Teknologi VIN — dan jawaban untuk pertanyaan Rust, Go, serta bahasa buatan Google

Dokumen ini menjawab pertanyaan: **"apa yang paling profesional dipakai, bagaimana kalau pakai Rust,
dan bagaimana dengan bahasa yang katanya dibuat Google sendiri?"**

Ringkasnya:

| Bagian | Pilihan | Alasan singkat |
| --- | --- | --- |
| Program on-chain (Solana) | **Rust + Anchor** | Ini satu-satunya pilihan serius untuk Solana. Bukan pilihan gaya, memang begitu ekosistemnya. |
| Backend API | **TypeScript (Node 22 + Hono)** untuk MVP, jalur naik ke **Go** bila salah satu angka terukur terlampaui | Kecepatan membangun, satu bahasa dengan frontend, mudah dipekerjakan. Go dipakai saat throughput/observability menuntut. |
| Frontend | **Next.js 15 (App Router) + React 19 + Tailwind v4** | Standar industri untuk pasar yang butuh SEO (halaman VIN harus terindeks) dan Server Components. |
| Basis data | **Postgres** di produksi (SQLite `node:sqlite` untuk demo/MVP) | Transaksi, audit, dan laporan. Skema di repo ini sengaja portabel. |
| Event log | **Append-only** di Postgres, hash diamankan ke Solana | Sumber kebenaran VIN adalah rangkaian event, bukan satu baris yang diedit. |
| Escrow | **Penyedia berizin** (rekening bersama / PJP) untuk fiat+stablecoin di MVP, **program Anchor** untuk lintas negara | Uang kendaraan tidak boleh lewat token volatil. |
| Identitas | **Sign-In With Solana + attestation** (mis. Solana Attestation Service) | Identitas usaha bisa diverifikasi ulang dan dicabut, bukan kolom `is_verified` di basis data. |
| Nota digital | **Metaplex Core** | Standar 2024+ yang lebih murah dan fleksibel dibanding Token Metadata lama. |
| Storage bukti | **S3/R2 + hash on-chain** (dan Arweave hanya untuk metadata nota) | Foto asli tidak ditaruh di chain. Yang dikunci hash. |
| RPC/indexer | **Helius** atau **QuickNode** + DAS API | Jangan menjalankan validator sendiri hanya untuk RPC aplikasi. |

---

## 1. Mengapa Rust hanya untuk program on-chain

Solana menjalankan program yang dikompilasi ke **BPF (SBF)**. Pilihan realistisnya:

- **Rust + Anchor** — standar produksi. Anchor menangani validasi akun, CPI, dan menghasilkan IDL.
- **Rust native** — dipakai bila butuh kontrol penuh atau menghemat compute unit.
- **C / C++** — didukung, tapi hampir tidak dipakai untuk proyek baru (tooling dan pustaka minim).
- **Python / TypeScript (Seahorse, dsb.)** — eksperimental; tidak layak untuk program yang memegang dana.

Jadi untuk lapisan on-chain, **Rust bukan pilihan estetika, melainkan satu-satunya jalur produksi**.
Program di repo ini ada di `programs/vin-anchor/`.

**Penting:** jangan pindahkan seluruh backend ke Rust hanya karena program on-chain memakai Rust.
Dua lapisan ini punya beban yang berbeda:

| Aspek | Program on-chain | Backend API |
| --- | --- | --- |
| Kebutuhan utama | Determinisme, keamanan, biaya compute per instruksi | Kecepatan membangun, integrasi vendor, iterasi produk |
| Siklus rilis | Lambat, harus diaudit, upgrade harus tata kelola | Harian, bisa di-deploy berkali-kali sehari |
| Kesalahan berakibat | Dana hilang, tidak bisa di-rollback | Bug fitur, bisa diperbaiki |
| Ekosistem SDM | Langka dan mahal di Indonesia | Banyak dan lebih murah |

Mencampur keduanya membuat kecepatan produk ikut lambat karena satu alasan yang salah.

## 2. Mengapa backend MVP TypeScript, bukan Go dari hari pertama

Yang menentukan biaya produksi VIN bukan bahasa, melainkan **integrasi**: KYC/KYB penjual,
webhook penyedia escrow, kurs mata uang, notifikasi, KYB bengkel, dan penanganan sengketa.
Semuanya pekerjaan integrasi, bukan pekerjaan CPU.

Manfaat nyata memilih TypeScript untuk MVP:

1. **Satu bahasa untuk frontend + backend + tipe domain bersama.** `packages/shared` dipakai
   API dan web sekaligus, sehingga aturan uang dan state machine tidak mungkin berbeda antara
   tampilan dan server.
2. **Vercel / Node runtime, tanpa server untuk dikelola.** Peluncuran cepat, biaya awal rendah.
3. **SDM mudah dicari**, ongkos penggantian engineer lebih rendah.

**Kapan pindah ke Go — dengan angka, bukan perasaan.** Pindah bila salah satu terjadi:

- p95 latensi endpoint deal > 300 ms dan profiling menunjukkan bottleneck di runtime aplikasi
  (bukan di basis data atau vendor);
- > 500 permintaan/detik berkelanjutan pada satu proses API;
- kebutuhan konkurensi berat: streaming event WebSocket/SSE dalam jumlah besar, atau fan-out
  notifikasi ke ribuan peserta lelang.

Bila itu terjadi, pindahkan **hanya** tiga service ke Go: `escrow-webhook`, `payout-worker`,
dan `notification-fanout`. Sisanya tetap TypeScript. Jangan menulis ulang semuanya.

**Catatan soal Go:** Go adalah bahasa yang dibuat Google — itu benar. Bahasa itu berguna dan
matang (Docker, Kubernetes, dan sebagian besar infrastruktur cloud memakainya). Yang **tidak**
benar adalah anggapan bahwa Go "dibuat untuk blockchain Solana". Program Solana tidak ditulis
dengan Go (SBF bukan target Go). Go cocok untuk backend service, bukan untuk lapisan dana di Solana.

## 3. Frontend

- **Next.js 15 App Router + React 19.** Halaman VIN (`/vin/[vin]`) harus bisa diindeks mesin pencari
  dan dibagikan sebagai tautan publik: ini nilai jual utama VIN. Server Components mengurangi data
  yang dikirim ke browser, yang penting di pasar dengan koneksi pas-pasan.
- **Tailwind CSS v4** untuk gaya yang konsisten tanpa menulis CSS global besar.
- **Wallet adapter** (Phantom/Solflare/Backpack) ditambahkan pada Tahap Pasar, bukan hari pertama:
  pembeli di koridor awal justru lebih nyaman memakai fiat. Menambahkan dompet di tahap yang salah
  memperbesar gesekan pendaftaran.
- **Mobile-first**. Pasar kendaraan lintas negara di Asia Tenggara mayoritas mengakses dari ponsel.

## 4. Basis data dan event

- **Postgres** di produksi. Tabel `events` bersifat append-only dan dilindungi aturan basis data
  (revoke UPDATE/DELETE untuk peran aplikasi).
- Skema di repo ini memakai `node:sqlite` (bawaan Node 22) supaya demo bisa dijalankan **tanpa**
  server basis data. Satu berkas `services/api/src/db.ts` berisi skema portabel; migrasi ke
  Postgres adalah pekerjaan mengganti driver, bukan menulis ulang model.
- Setiap VIN punya **nomor urut event** (`UNIQUE (vin, seq)`) sehingga celah atau pengulangan
  bisa terdeteksi.

## 5. Solana: apa yang dipakai dan apa yang tidak

**Dipakai**

| Bagian | Teknologi | Catatan |
| --- | --- | --- |
| Escrow stablecoin | Anchor program, vault PDA, USDC | Dua vault terpisah: kendaraan dan inspeksi |
| Jaminan | Token-2022 atau SPL token transfer ke vault jaminan | Jaminan kembali/terpotong, tidak pernah jadi bagi hasil |
| Nota | Metaplex Core (`record_note` + aset) | Hash yang masuk chain, bukan foto |
| Identitas | Solana Attestation Service (SAS) | Attestation bisa dicabut; datanya tetap off-chain |
| Biaya & antrean | Fee dalam stablecoin, diskon bila memakai token platform | Tanpa token tetap bisa memakai platform |
| RPC | Helius/QuickNode + DAS API | Untuk membaca aset nota dan riwayat |

**Tidak dipakai, dan alasannya**

- **Token volatil sebagai alat bayar kendaraan.** Ini melanggar aturan yang sudah ditulis di konsep
  VIN, dan membebani penjual dengan risiko kurs.
- **NFT sebagai bukti kepemilikan hukum.** BPKB/title tidak sah digantikan hash.
- **Memindahkan seluruh logika ke chain pada tahap awal.** Yang perlu on-chain hanya yang menyangkut
  uang dan jaminan. Harga, inspeksi, dan reputasi boleh dihitung di server, dengan event log sebagai bukti.
- **Menulis foto atau data pribadi ke chain.** Sekali ditulis, tidak bisa dihapus (bertentangan dengan
  UU PDP).

## 6. Kalau memang ingin seluruh backend Rust

Bisa, dan tidak salah, dengan catatan berikut:

- **Axum atau Actix Web** untuk API; **sqlx** untuk Postgres; **chrono/time** untuk waktu;
  **serde** untuk serialisasi.
- Jangan menulis skema dan aturan dua kali. Sebaiknya hashing kanonik dan aturan state machine
  ditulis di satu tempat (crate bersama `vin-core`), lalu dipakai program Anchor dan API.
  Inilah satu-satunya cara "Rust end-to-end" menjadi waras.
- Harga yang dibayar: waktu perekrutan lebih lama, kecepatan iterasi lebih lambat, dan setiap
  perubahan skema butuh kompilasi. Untuk tim kecil, itu biaya nyata.
- Rekomendasi saya: **mulai TypeScript, siapkan jalur Rust** — dan jalur Rust itu sudah ada di repo
  ini pada bentuk yang paling penting: program escrow di `programs/vin-anchor/`.

## 7. Ringkasan keputusan yang bisa dibela ke investor atau auditor

1. Uang kendaraan: stablecoin/fiat lewat penyedia berizin; on-chain hanya ketika koridor
   sudah lintas negara dan penyedia fiat tidak menjangkau.
2. Yang di-hash di Solana hanya bukti; yang dihitung di server adalah kebijakan.
3. Token platform hanya untuk jaminan dan akses. Tidak ada janji hasil.
4. Teknologi dipilih untuk mempercepat **deal selesai**, bukan untuk memperindah narasi.
   Keempat angka di dokumen konsep §10 tetap menjadi penentu, bukan pilihan bahasa.
