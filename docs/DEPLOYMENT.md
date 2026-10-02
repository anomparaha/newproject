# Deployment — dari demo ke Solana

## 1. Bentuk deployment yang disarankan

| Komponen | Tempat | Catatan |
| --- | --- | --- |
| `apps/web` (Next.js) | Vercel / platform Node | Atur `VIN_API_URL` ke alamat API internal |
| `services/api` (Hono) | Fly.io, Railway, Zeabur, atau VPS Node 22 | Bind `0.0.0.0`; jangan taruh kunci rahasia di lingkungan frontend |
| Basis data | Postgres terkelola (Neon, Supabase, RDS) | Pindahkan dari `node:sqlite` sebelum koridor kedua |
| Bukti (foto/laporan) | S3 / Cloudflare R2 | Simpan hash di basis data, berkas di bucket privat |
| RPC Solana | Helius / QuickNode | Jangan jalankan validator hanya untuk RPC |
| Program Anchor | Solana (devnet → mainnet) | Lihat bagian 4 |

Aturan yang tidak boleh dilanggar saat men-deploy:

- **Browser tidak pernah memanggil `localhost`.** Semua panggilan lewat rute relatif `/api/*`
  (rewrite di `apps/web/next.config.ts`).
- **Server bind ke `0.0.0.0`**, bukan `127.0.0.1`, agar bisa diakses di lingkungan preview.
- **Kunci relayer/arbiter tidak pernah masuk repo atau bundle frontend.** Gunakan secret manager.

## 2. Langkah deploy MVP (tanpa on-chain)

1. Deploy `services/api` dengan env: `PORT`, `VIN_DEMO_MODE=false`, `VIN_DB_PATH` (atau URL Postgres
   setelah migrasi), lalu `npm run build:shared` di langkah build.
2. Deploy `apps/web` dengan env `VIN_API_URL` menunjuk ke API di atas.
3. Matikan mode demo sehingga `x-actor-id` dan `x-demo-backdate-hours` tidak berlaku lagi.
4. Ganti autentikasi ke Sign-In With Solana sebelum mengumumkan ke publik.

## 3. Kesiapan sebelum menyentuh dana nyata

- [ ] Audit program Anchor selesai dan temuan diperbaiki.
- [ ] Multisig (mis. Squads) sebagai admin program; relayer sebagai hot key dengan batas harian.
- [ ] Timelock untuk perubahan konfigurasi dan upgrade program.
- [ ] Rekonsiliasi harian: event log ⇄ escrow provider ⇄ saldo on-chain.
- [ ] Prosedur darurat: jeda program (`paused`), pembekuan escrow, komunikasi ke pengguna.
- [ ] Uji beban pada endpoint deal dan webhook pendanaan.

## 4. Menghidupkan jalur on-chain

```bash
# 1. Pasang toolchain (sekali)
#    Rust + Solana CLI + Anchor 0.30.1  -> lihat .github/workflows/anchor.yml

# 2. Build & uji program
cd programs/vin-anchor
anchor build
anchor test            # WAJIB: uji invariant (lihat komentar di tests/vin_anchor.ts)

# 3. Deploy ke devnet lebih dulu
solana config set --url devnet
anchor deploy

# 4. Catat program id hasil deploy, lalu:
#    - ganti declare_id! di src/lib.rs
#    - set VIN_ESCROW_PROGRAM_ID di lingkungan API
#    - jalankan initialize_config dengan admin = multisig, arbiter, relayer
```

Setelah program berjalan, tukar implementasi escrow di API:

```ts
// services/api/src/app.ts
const ctx = {
  db,
  escrow: new MockEscrowProvider(db),                       // demo
  // escrow: new AnchorEscrowProvider(rpcUrl, programId),   // produksi
};
```

Kontrak `EscrowProvider` (`packages/shared/src/escrow.ts`) tidak berubah, sehingga logika deal,
rute, dan UI tidak perlu ditulis ulang. Stub `AnchorEscrowProvider` sengaja **melempar error** selama
program belum benar-benar di-deploy — supaya tidak ada klaim dana on-chain yang palsu.

## 5. Nota (NFT) — urutan yang benar

1. Deal selesai → event `note_completed` mencatat `evidence_root` dan `escrowTxId`.
2. Metadata nota tersedia di `GET /api/notes/:id/metadata` (kompatibel Metaplex Core).
3. Tahap Bukti: cetak aset lewat relayer (SDK TypeScript Metaplex Core), lalu panggil
   `record_note` untuk merekam alamat aset ke PDA.
4. Setelah audit: aktifkan fitur `metaplex-core` dan cetak langsung dari program (CPI).

Di kedua jalur, **isi on-chain tetap hanya hash** — foto dan laporan mentah tinggal off-chain.

## 6. Checklist per koridor

- [ ] Koridor terdaftar di tabel `corridors` dengan ambang nilai dan mata uang yang sah.
- [ ] Bengkel terverifikasi + jaminan kapasitas terkunci.
- [ ] Mitra escrow/pembayaran berizin di kedua negara.
- [ ] SOP sengketa dan daftar arbiter dengan konflik kepentingan yang diumumkan.
- [ ] Halaman metrik koridor menampilkan angka nyata (bukan ditulis manual).
- [ ] Perluasan ke koridor berikutnya hanya dibuka setelah koridor ini lolos gate di `ROADMAP.md`.
