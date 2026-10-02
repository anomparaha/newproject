# Arsitektur VIN

## 1. Lapisan

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/web (Next.js)                                              │
│  Server Components membaca API; aksi tombol memanggil /api/*    │
└───────────────┬─────────────────────────────────────────────────┘
                │ rewrite /api/*  (relatif, bukan localhost)
┌───────────────▼─────────────────────────────────────────────────┐
│ services/api (Hono)                                             │
│  routes/  → aktor, koridor, listing, deal, reputasi, meta       │
│  events.ts → EVENT LOG append-only (sumber kebenaran per VIN)   │
│  escrow.ts → EscrowProvider: mock | anchor_solana | custodian   │
│  policy.ts → fee, jaminan, kapasitas, ambang berhenti perluasan │
└──────┬──────────────────────────────┬───────────────────────────┘
       │                              │
┌──────▼───────────────┐   ┌──────────▼──────────────────────────┐
│ Postgres (produksi)  │   │ Solana                              │
│ node:sqlite (demo)   │   │  programs/vin-anchor: vault PDA,    │
│ events, deals, ...   │   │  jaminan, arbiter, registri nota    │
└──────────────────────┘   │  Metaplex Core: aset nota           │
                           └─────────────────────────────────────┘
```

## 2. Event log adalah sumber kebenaran

Satu VIN memiliki **rangkaian event**, bukan satu berkas yang diedit:

```
linimasa VIN JTDKAMFU1M3123456
#1 listing_created      (penjual)     merek, model, harga, hash foto
#2 deal_committed       (pembeli)     bengkel dipilih, batas waktu, escrow ref
#3 report_uploaded      (bengkel)     odometer, hash laporan, hash foto dasbor
#4 odometer_anomaly     (sistem)      odometer turun vs catatan sebelumnya
#5 inspeksi_dana_lepas  (pembeli)     fee platform dipotong
#6 kendaraan_dana_lepas (sistem)      syarat serah terima terpenuhi
#7 note_completed       (sistem)      root bukti, tx escrow, status
```

Konsekuensi teknis:

- Tabel `events` **append-only**. Tidak ada `UPDATE`/`DELETE` di aplikasi. Di Postgres, cabut hak
  `UPDATE`/`DELETE` untuk peran aplikasi sebagai pertahanan berlapis.
- `UNIQUE (vin, seq)` membuat celah atau pengulangan nomor urut langsung terdeteksi.
- Proyeksi (`listings.status`) hanya untuk pencarian, dan **bisa dibangun ulang** dari event kapan pun.
- Kolom `anchor_signature` diisi setelah hash benar-benar ditulis ke Solana. Selagi kosong, UI
  menampilkan label `off-chain` — tidak ada klaim anchoring palsu.

## 3. Uang: dua escrow, satu arah

- `escrows` unik per `(deal_id, leg)` dengan `leg ∈ {vehicle, inspection}`.
- Dana inspeksi cair setelah laporan memenuhi standar **dan** pembeli menerima (atau batas waktu lewat).
- Dana kendaraan cair setelah syarat serah terima yang dikunci di awal terpenuhi.
- Setiap pelepasan wajib menyertakan `evidenceEventIds`; provider melempar error bila kosong.
  Jadi mustahil melepas dana tanpa bukti yang bisa ditelusuri.
- Aritmetika uang memakai **bilangan bulat terskala** (`BigInt`, skala 6 untuk USDC, 0 untuk IDR).
  Tidak ada float di jalur uang — lihat `packages/shared/src/money.ts` dan ujinya.

## 4. Peran dan pemisahan wewenang

| Peran | Boleh | Tidak boleh |
| --- | --- | --- |
| Penjual | Membuat listing, mengunci jaminan, konfirmasi serah terima | Memilih bengkel untuk unitnya sendiri |
| Pembeli | Memilih bengkel, mendanai escrow, menerima laporan, konfirmasi serah terima | Mengakses laporan bengkel untuk order lain |
| Bengkel | Menerima order, mengunggah laporan | Membuat listing, memilih dirinya sendiri |
| Kurator | Verifikasi identitas usaha, mencatat afiliasi, membuka koridor | Menyentuh escrow |
| Arbiter | Memutuskan sengketa, memicu potongan jaminan | Melepas dana tanpa sengketa |

Afiliasi penjual–bengkel dicatat dan diperiksa saat pemilihan bengkel: bengkel terafiliasi
**diblokir** dari order unit penjual tersebut (`INSPECTOR_CONFLICT`).

## 5. Abstraksi escrow

`EscrowProvider` (`packages/shared/src/escrow.ts`) punya tiga implementasi yang mungkin:

| Implementasi | Kapan dipakai | Status di repo |
| --- | --- | --- |
| `MockEscrowProvider` | Demo dan pengujian | Jalan |
| `AnchorEscrowProvider` | Saat koridor lintas negara butuh settlement on-chain | Stub yang menolak berjalan sampai program di-deploy |
| Kustodian berizin | Fiat dan kepatuhan lokal | Kontrak antarmuka sudah siap |

Fungsi-fungsi: `createEscrow`, `fund`, `release`, `freeze`, `slash`, `refund`, `partialRelease`.
Semuanya menerima bukti (`evidenceEventIds`) atau alasan (`reason`) yang dicatat.

## 6. Hashing dan data off-chain

- Foto, laporan mentah, dan dokumen: **off-chain** (S3/R2), hanya hash SHA-256 yang dikunci.
- `anchorPayloadHash()` memakai **JSON kanonik** sehingga hash bisa direproduksi pihak ketiga.
- `evidenceRoot()` (Merkle sederhana) merangkum seluruh bukti satu nota.
- VIN di platform **bukan** VIN registrasi resmi. Setiap halaman kendaraan menampilkan peringatan ini
  lewat `vinScopeNotice()`.

## 7. Anomali kilometer

Aturan: dasar pembanding adalah **`maxOdometer` — angka tertinggi yang pernah tercatat** pada VIN yang
sama (dari event `listing_created` dan `report_uploaded`), **bukan angka terakhir**. Bila sebuah
laporan lebih rendah dari titik tertinggi itu, sistem menulis event `odometer_anomaly` berisi nilai
pembanding dan selisihnya.

> Kenapa bukan angka terakhir: satu laporan rendah akan **mereset** dasar pembanding, sehingga anomali
> berikutnya hilang. Titik tertinggi hanya bisa naik, jadi tidak bisa dimundurkan. Fungsi
> `latestOdometer()` tetap ada, tetapi hanya untuk **tampilan** riwayat.

- Listing ulang sebuah VIN di bawah rekor tertingginya **diterima**, tetapi tidak pernah senyap:
  `POST /api/listings` menulis event `odometer_anomaly` dan mengembalikan `odometerWarning` supaya
  pembeli melihatnya.
- Anomali **tidak** menolak otomatis.
- Pembeli **wajib** menandai bahwa peringatan sudah dibaca sebelum dana inspeksi dilepas
  (`acknowledgeAnomaly`), dan permintaan akan ditolak tanpa flag itu. Pemeriksaan ini mencakup
  seluruh riwayat VIN, termasuk peringatan dari listing ulang.
- Aturan ini tidak boleh diubah mundur pada tahap perluasan; perubahan aturan harus terlihat di event log.

## 8. Keamanan dan ancaman utama

| Ancaman | Mitigasi saat ini | Yang masih kurang |
| --- | --- | --- |
| Penjual menghilang setelah dana masuk | Jaminan listing + pembekuan escrow + arbitrase | Pelacakan identitas dan penagihan lintas negara |
| Bengkel memberi laporan palsu | Jaminan bengkel, reputasi, ketentuan afiliasi, hash yang bisa diaudit | Kalibrasi acak oleh kurator, inspeksi ulang (spot check) |
| Anomali odometer disembunyikan | Event anomali tidak bisa dihapus, wajib di-acknowledge | Integrasi data odometer pihak ketiga |
| Manipulasi reputasi | Reputasi dihitung dari event, ranking tidak dijual | Audit independen atas perhitungan skor |
| Kunci relayer dicuri | (Rencana) multisig Squads + timelock + batas harian | Belum ada; hari ini disimulasikan |
| Data pribadi bocor | Tidak ada data pribadi on-chain; hash saja | Enkripsi kolom sensitif, pemisahan PII dari DB utama |
| Bug pada program escrow | Belum ada program yang berjalan | Audit pihak ketiga, fuzzing, uji properti |

## 9. Skalabilitas

MVP sadar batasnya:

- `node:sqlite` cukup untuk demo dan koridor pertama (ribuan deal). Pindah Postgres sebelum
  koridor kedua dibuka.
- Pekerjaan asinkron (pengiriman email/WhatsApp, penarikan dana, rekonsiliasi) sebaiknya masuk
  antrean (mis. pg-boss atau SQS) — belum ada di repo ini.
- RPC Solana memakai penyedia (Helius/QuickNode). Jangan menjalankan validator untuk kebutuhan aplikasi.
