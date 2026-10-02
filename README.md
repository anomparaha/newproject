# VIN — pasar kendaraan lintas negara

Listing terkunci, dana di **escrow**, laporan inspeksi menempel pada **nomor rangka**, dan deal selesai
dicatat sebagai **bukti digital yang tidak bisa ditimpa**.

> **VIN tidak memindahkan kepemilikan hukum.** BPKB, title, registrasi, bea cukai, pajak, dan balik
> nama tetap mengikuti hukum negara asal dan negara tujuan. **NFT bukan surat kendaraan.**
> **Uang kendaraan tidak lewat token volatil.** Token hanya jaminan dan akses.

---

## 1. Status repo ini — apa yang sudah jalan dan apa yang belum

Jujur di depan, supaya tidak ada klaim palsu:

**Sudah jalan dan sudah diuji di repo ini**

- API Hono + `node:sqlite`: aktor, koridor, listing, deal, escrow dua leg, laporan inspeksi,
  anomali kilometer, serah terima, nota, sengketa, arbitrase, reputasi, metrik koridor.
- **Alur penuh lolos uji integrasi**: listing → escrow → inspeksi → laporan → penerimaan pembeli →
  serah terima → pelepasan dana kendaraan → nota tercatat, plus satu kasus **anomali kilometer**
  yang berujung **sengketa** dan **jaminan terpotong** (`npm run seed:reset`).
- **41 uji** (`npm test`): 11 uji aturan inti (aritmetika uang desimal, state machine, prasyarat
  pelepasan dana, anomali odometer, potongan jaminan) + **11 uji properti** untuk model ledger escrow
  (ribuan kombinasi acak: over-release, double refund, putusan tidak tepat habis, bypass
  pembekuan, dan deal wajib selesai sebelum nota boleh dicatat) + **19 uji aturan on-chain**
  hasil rekonsiliasi dengan spesifikasi rancangan lima-kontrak: urutan pemanggilan wajib (di luar
  urutan ditolak), satu VIN hanya satu deal, anomali odometer dihitung dari titik tertinggi dan tidak
  bisa direset laporan rendah, serta jendela konfirmasi serah-terima.
- Frontend Next.js: dasbor, listing, konsol deal, halaman VIN, pasar inspeksi, koridor, kebijakan.
  Aksi tombol (danai escrow, unggah laporan, terima laporan, serah terima, lepas dana, sengketa,
  putusan arbiter) memanggil API sungguhan.

**Belum jalan / belum diverifikasi**

- `programs/vin-anchor/` (Rust + Anchor) — **belum dikompilasi maupun di-deploy**. Toolchain Rust dan
  Solana tidak tersedia di lingkungan pengembangan ini (host rust-lang/crates.io diblokir di sandbox).
  Jalankan `anchor build && anchor test` sebelum mengklaim apa pun tentang dana on-chain.
  Rinciannya, termasuk **3 temuan review yang sudah diperbaiki** dan daftar yang belum ada:
  **`docs/PROGRAM.md`**.
- Selama program belum di-deploy, aturan vault tetap diuji lewat **model ledger TypeScript**
  (`packages/shared/src/vault-spec.ts`) dengan uji properti — lihat `npm test`.
- Escrow yang berjalan sekarang adalah `MockEscrowProvider` (meniru ledger penyedia berizin).
  Belum ada uang nyata bergerak di mana pun.
- **Belum ada NFT yang dicetak.** `note_completed` mencatat `noteAssetId: null` dan metadata nota
  sudah disiapkan kompatibel Metaplex Core (`GET /api/notes/:id/metadata`).
- Autentikasi masih memakai header `x-actor-id` (**hanya untuk demo**). Produksi: Sign-In With Solana
  + attestation.
- Belum ada KYC/KYB vendor, belum ada audit keamanan, belum ada izin OJK (lihat `docs/LEGAL.md`).

## 2. Struktur repo

```
apps/web/                  Next.js 15 (App Router, React 19, Tailwind v4)
services/api/              API Hono + node:sqlite (skema portabel ke Postgres)
packages/shared/           Tipe, aturan state machine, aritmetika uang, hashing (dipakai API + web)
programs/vin-anchor/       Program Solana (Rust + Anchor): escrow, jaminan, registri nota
docs/                      Arsitektur, pilihan teknologi, API, roadmap, batas hukum
```

## 3. Menjalankan

```bash
npm install

# 1. Bangun paket domain bersama
npm run build:shared

# 2. Isi data demo (sekaligus uji integrasi alur penuh)
npm run seed:reset

# 3. Jalankan API dan web (dua terminal)
npm run dev:api     # http://0.0.0.0:8080
npm run dev:web     # http://0.0.0.0:3000

# Uji aturan inti
npm test
```

Frontend memanggil backend lewat rute relatif `/api/*` yang diteruskan oleh rewrite Next
(`apps/web/next.config.ts`), jadi browser tidak pernah memanggil `localhost` langsung.

### Coba alurnya sebagai tiga orang

Di sidebar ada **Persona demo**. Pilih aktor, lalu kerjakan langkah berikut:

1. **Pembeli** → buka listing → *Kunci deal & danai escrow*. Dua escrow dibuat terpisah.
2. **Bengkel Inspeksi Nusantara** → unggah laporan (tombol *contoh* mengisi hash sha256).
   Untuk melihat anomali: isi odometer lebih rendah dari catatan penjual pada VIN itu.
3. **Pembeli** → terima laporan (wajib mencentang peringatan anomali bila ada).
4. **Pembeli & Penjual** → konfirmasi serah terima → **lepas dana kendaraan** → nota tercatat.
5. Untuk sengketa: pilih **Arbiter** lalu putuskan. Coba juga memilih bengkel **Sahabat Motor**
   saat mengunci deal — bengkel itu terafiliasi dengan penjual dan **diblokir** oleh sistem.

## 4. Aturan yang ditegakkan mesin (bukan hanya niat di dokumen)

| Aturan | Di mana ditegakkan |
| --- | --- |
| Dana kendaraan tidak cair sebelum syarat serah terima | `vehicleReleasePreconditions` + `POST /deals/:id/release-vehicle` (409 bila belum) |
| Dana inspeksi tidak cair sebelum laporan lengkap | `inspectionReleasePreconditions` + `POST /deals/:id/reports/:rid/accept` |
| Penjual tidak memilih inspektor; bengkel terafiliasi diblokir | `INSPECTOR_CONFLICT` pada `POST /listings/:id/deals` |
| Event lama tidak bisa diedit | Tabel `events` append-only + nomor urut `UNIQUE (vin, seq)` |
| Anomali kilometer tetap terlihat | `odometer_anomaly` + penerimaan laporan wajib acknowledge |
| Sengketa membekukan escrow dan nota | `freeze_deal` + status `frozen` menolak pelepasan |
| Jaminan terpotong masuk kas sengketa | `slashBond()` + `dispute_fund`, bukan dompet tim |
| Dua escrow terpisah (uang kendaraan vs inspeksi) | `escrows` unik per `(deal_id, leg)`; dua vault di Anchor |
| Perluasan koridor dihentikan bila 4 angka buruk sekaligus | `evaluateCorridorHealth()` + `expansionHalted` |

## 5. Endpoint penting

```
GET  /api/meta/policy                  seluruh kebijakan publik (fee, jaminan, tahapan, taksonomi event)
GET  /api/metrics/token                jaminan terkunci (satu-satunya "metrik token" yang diklaim)
GET  /api/listings                     daftar listing + koridor yang dilayani
GET  /api/vin/:vin                     rangkaian event, laporan, nota, anomali, batas klaim
POST /api/listings/:id/deals           pembeli mengunci deal (dua escrow dibuat)
POST /api/deals/:id/fund               pendanaan escrow (produksi: webhook penyedia berizin)
POST /api/deals/:id/reports            bengkel mengunggah laporan (hash saja)
POST /api/deals/:id/reports/:rid/accept  pembeli menerima laporan -> dana inspeksi lepas
POST /api/deals/:id/handover           konfirmasi serah terima per pihak
POST /api/deals/:id/release-vehicle    lepas dana kendaraan + catat nota
POST /api/deals/:id/disputes           buka sengketa (membekukan escrow)
POST /api/disputes/:id/resolve         putusan arbiter
GET  /api/inspectors                   pasar inspeksi (ranking dari kinerja, bukan dibeli)
GET  /api/corridors/:id/metrics        metrik publik + pemicu berhenti perluasan
GET  /api/notes/:id/metadata           metadata nota kompatibel Metaplex Core
```

Referensi lengkap: `docs/API.md`.

## 6. Pertanyaan tentang Rust, Go, dan "bahasa buatan Google"

Jawabannya ada di **`docs/TECH_STACK.md`**. Ringkasan:

- **Program on-chain wajib Rust + Anchor** — bukan soal selera, itu satu-satunya jalur produksi Solana.
- **Backend MVP TypeScript** (Node 22 + Hono) karena yang menentukan biaya bukan bahasa, melainkan
  integrasi KYC, escrow berizin, dan sengketa; plus satu bahasa dengan frontend memudahkan tipe bersama.
- **Go tetap disiapkan sebagai jalur keluar yang terukur**: pindah hanya bila p95 endpoint deal
  > 300 ms karena runtime, atau > 500 rps berkelanjutan. Pindahkan tiga service, bukan semuanya.
- **Go adalah bahasa buatan Google** — itu betul, dan Go dipakai luas untuk infrastruktur. Yang keliru
  adalah menganggap Go dipakai untuk program Solana. Program Solana tidak dikompilasi dari Go.

## 7. Urutan peluncuran

Empat tahap dari dokumen konsep, dipetakan ke pekerjaan nyata:

1. **Tahap Bukti** — satu koridor, inspeksi wajib, escrow wajib, riwayat VIN menyala, NFT nota hanya
   untuk deal selesai, **belum ada penjualan token ke publik**, jaminan dalam stablecoin.
2. **Tahap Pasar** — bengkel pihak ketiga, standar laporan dan pembekuan sengketa berjalan,
   metrik publik: deal selesai, waktu median sampai laporan, tingkat sengketa.
3. **Tahap Token** — token terbit hanya setelah ada penjual dan bengkel yang benar-benar
   membutuhkan jaminan dan potongan fee. Tanpa alokasi yang dibingkai sebagai hak atas pendapatan.
4. **Tahap Perluasan** — koridor kedua, aturan anomali kilometer tidak diubah mundur.

Rincian pekerjaan, gate, dan checklist mainnet: **`docs/ROADMAP.md`**.

## 8. Dokumen lain

- `docs/ARCHITECTURE.md` — arsitektur, model data, alur dana, keamanan.
- `docs/TECH_STACK.md` — pilihan teknologi + jawaban Rust/Go.
- `docs/API.md` — referensi endpoint.
- `docs/ROADMAP.md` — tahapan, gate, checklist produksi & mainnet.
- `docs/FLOW.md` — **alur smart contract langkah demi langkah**: siapa menandatangani apa, diagram
  jalur bahagia & sengketa, dan apa yang dijaga program vs tidak.
- `docs/PROGRAM.md` — referensi smart contract: akun, instruksi, invarian, temuan review, yang belum ada.
- `docs/SPEC_RECONCILIATION.md` — **perbandingan alur rancangan lima-kontrak vs implementasi**: 20
  perbedaan, dua bug logika penting, penilaian per area, dan urutan adopsi bertahap.
- `docs/DEPLOYMENT.md` — deploy MVP, kesiapan dana nyata, dan cara menghidupkan jalur on-chain.
- `docs/LEGAL.md` — batas hukum, kepatuhan, dan apa yang **tidak boleh** dipublikasikan.

## 9. Peringatan

Repositori ini adalah **fondasi produk**, bukan janji investasi. Tidak ada token yang dijual, tidak ada
proyeksi harga, dan tidak ada janji hasil untuk siapa pun. Sebelum uang nyata bergerak: audit kontrak,
izin penyelenggara yang berlaku, dan pendapat hukum di kedua negara koridor.
