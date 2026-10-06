# Fase 1 — Menerjemahkan model aturan ke program Anchor

> Dokumen ini adalah **spesifikasi kerja**, bukan laporan bahwa pekerjaannya sudah selesai.
> Sampai Fase 1 ditutup, semua yang berjalan adalah **API + escrow mock**; belum ada dana
> on-chain yang teruji. Lihat `docs/SPEC_RECONCILIATION.md` untuk konteks keputusannya.

## 1. Tujuan Fase 1

Menjadikan **satu program Anchor** sebagai penjaga aturan, bukan sekadar tempat menyimpan saldo.
Target akhir Fase 1 (dari `SPEC_RECONCILIATION.md`):

1. `DealState` eksplisit — urutan pemanggilan yang salah **ditolak**, bukan diabaikan.
2. Registry VIN **di dalam program**, sehingga satu VIN hanya boleh punya satu deal aktif.
3. Gerbang `maxOdometer` di on-chain: anomali dihitung dari **angka tertinggi**, dan tidak bisa
   di-reset oleh laporan rendah.
4. Cabang sengketa dengan pembagian dana yang **tepat habis** (tidak ada dana tersangkut).
5. `record_note` hanya boleh setelah dana kendaraan benar-benar lepas.

Alasan urutan ini: perilakunya **sudah terkunci uji** di sisi TypeScript (63 uji, termasuk uji
properti). Fase 1 memindahkan aturan yang sudah tetap itu ke Rust, bukan menemukan aturan baru.

## 2. Yang sudah ada di program sekarang

Instruksi inti escrow (sebelum Fase 1) di `programs/vin-anchor/src/lib.rs`:

| Instruksi | Peran pemanggil | Catatan |
| --- | --- | --- |
| `initialize_config` | admin | `fee_treasury` dikunci di sini; fee tidak bisa diarahkan relayer |
| `set_authorities` | admin | ganti relayer/arbiter/treasury |
| `register_actor` / `revoke_actor` | admin | attestation hash; aktor dicabut tidak boleh buka deal |
| `lock_bond` / `return_bond` | aktor / admin | jaminan stablecoin |
| `open_deal` + `open_deal_vaults` | pembeli | dua instruksi dalam satu transaksi: akun deal, lalu dua vault terpisah |
| `fund_leg` | pembeli | dipanggil dua kali (kendaraan, inspeksi) |
| `freeze_deal` | pihak mana pun | membekukan deal |
| `release_leg` / `refund_leg` | relayer | menolak deal beku |
| `resolve_dispute` | arbiter | pembagian wajib tepat habis |
| `slash_bond` | arbiter | potongan masuk `dispute_fund`, bukan dompet tim |
| `record_note` | relayer | `init` (bukan `init_if_needed`) — sekali catat |

> **Pembaruan (Fase 1 — kode).** Sejak baris di atas ditulis, empat hal yang dulu "belum ada"
> kini **sudah** diimplementasikan di `lib.rs` dan lulus `cargo check` host (serta
> `anchor build --no-idl`): `DealState` (enum, menggantikan tiga bool `frozen`/`cancelled`/`completed`),
> registry VIN (`VinRecord`), gerbang odometer high-water, dan penolakan double-deal per VIN lewat
> `record_reserve`. Program juga menambah empat instruksi tahap-deal — `submit_report`,
> `accept_report`, `mark_handover`, `confirm_handover` — dengan gerbang `require_state` yang menolak
> urutan di luar `DEAL_ORDER`. Status Definisi Selesai yang akurat ada di §8; status toolchain di §10.

## 3. Perubahan akun

### 3.1 `DealAccount.state`

Ganti tiga bool dengan satu enum. Nomornya **disamakan** dengan `STAGE` di
`packages/shared/src/onchain-rules.ts` supaya model TypeScript dan Rust bisa dibandingkan 1:1.

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum DealState {
    Empty = 0,          // belum ada
    Staked = 1,         // jaminan terkunci
    Listed = 2,         // listing tercatat di registry
    Reserved = 3,       // deal dibuat, listing terkunci
    Funded = 4,         // dana kendaraan masuk
    Inspecting = 5,     // dana inspeksi masuk
    ReportSubmitted = 6,
    ReportAccepted = 7,
    HandoverMarked = 8,
    HandoverConfirmed = 9,
    Released = 10,
    Noted = 11,         // terminal sukses
    Frozen = 90,        // sengketa
    Resolved = 91,      // keputusan arbiter
    Cancelled = 92,     // terminal gagal (pembatalan / refund penuh)
}
```

Terminal: `Noted` (sukses) dan `Cancelled` (gagal). `Frozen` bukan terminal — hanya arbiter yang
boleh keluar darinya, menuju `Cancelled` atau kembali ke jalur sukses.

### 3.2 `VinRecord` — PDA baru

`seeds = [b"vin", vin_hash]`. Hanya hash yang on-chain, VIN mentah tetap off-chain.

```rust
pub struct VinRecord {
    pub vin_hash: [u8; 32],
    pub seller: Pubkey,
    pub last_odometer: u64,      // tampilan riwayat
    pub max_odometer: u64,       // DASAR anomali - hanya boleh naik
    pub anomaly_pending: bool,   // wajib di-acknowledge sebelum report diterima
    pub events: u32,             // append-only, hanya bertambah
    pub listing_recorded: bool,
    pub reserved_by_deal: Option<Pubkey>,
    pub completion_recorded: bool,
    pub dispute_open: bool,
    pub bump: u8,
}
```

## 4. Instruksi baru (registry + gerbang)

| Instruksi | Aturan yang ditegakkan |
| --- | --- |
| `init_vin_record` | sekali per `vin_hash`; gagal bila akun sudah ada |
| `record_listing` | hanya pemilik record; `listing_recorded` sekali saja |
| `record_reserve` | **menolak bila `reserved_by_deal` sudah terisi** → satu VIN satu deal aktif |
| `release_reserve` | hanya deal yang memegang reserve |
| `record_inspection` | baseline = `max_odometer`; bila `odometer < max_odometer` → set `anomaly_pending = true` dan emit `odometer_anomaly`; `max_odometer = max(max_odometer, odometer)` |
| `acknowledge_anomaly` | hanya pembeli; membersihkan `anomaly_pending` |
| `record_completion` | hanya setelah `Released`; sekali saja |
| `record_dispute` / `record_resolution` | membuka/menutup `dispute_open` |

Gerbang di jalur dana:

- `accept_report` (padanan `release_leg` untuk leg inspeksi) **menolak** bila
  `anomaly_pending == true` → pembeli wajib melihat peringatan lebih dulu.
- `release_leg` (kendaraan) hanya dari `HandoverConfirmed`, dan tidak berlaku saat `Frozen`.

## 5. Pemetaan instruksi lama → Fase 1

| Sekarang | Fase 1 | Perubahan |
| --- | --- | --- |
| `lock_bond` | `lock_bond` | tetap; sekaligus menandai `Staked` |
| — | `record_listing` | baru; menulis `VinRecord` |
| `open_deal` | `create_deal` | + `record_reserve` (tolak VIN yang sudah punya deal aktif) |
| `fund_leg(0)` | `deposit` | + transisi `Reserved → Funded` |
| `fund_leg(1)` | `fund_inspection` | + transisi `Funded → Inspecting` |
| — | `submit_report` | baru; memanggil `record_inspection` (gerbang odometer) |
| — | `accept_report` | baru; menolak bila `anomaly_pending` |
| — | `mark_handover` / `confirm_handover` | baru; jendela konfirmasi |
| `release_leg` | `release_leg` | + wajib `HandoverConfirmed` |
| `record_note` | `record_note` | + wajib `Released` (bukan hanya flag `completed`) |
| `freeze_deal` | `open_dispute` | + `record_dispute` |
| `resolve_dispute` | `resolve_dispute` | tetap; exact accounting dipertahankan |

Tabel transisi lengkapnya sudah ada di `packages/shared/src/onchain-rules.ts` (`DEAL_ORDER`) dan
harus disalin **apa adanya** — jangan ditafsir ulang saat menulis Rust.

## 6. Invarian yang wajib dijaga

1. Satu VIN → maksimal satu deal aktif (bug lama: `open_deal` memakai seeds `[deal, vin_hash, buyer]`,
   sehingga dua pembeli bisa membuka dua deal paralel untuk VIN yang sama).
2. `max_odometer` hanya boleh naik (bug lama: dasar anomali dihitung dari angka terakhir, sehingga
   satu laporan rendah mereset dasarnya).
3. Tidak ada pelepasan dana sebelum `HandoverConfirmed`; tidak ada pelepasan saat `Frozen`.
4. Pembagian dana tepat habis — sisa wajib nol, tidak boleh ada saldo menganggur di vault.
5. `record_note` hanya sekali per deal, dan hanya setelah `Released`.
6. Potongan jaminan masuk `dispute_fund`, tidak pernah ke dompet tim/arbiter/relayer.
7. Fee hanya ke `config.fee_treasury` (constraint akun, bukan pilihan pemanggil).
8. Urutan di luar tabel `DEAL_ORDER` ditolak.

## 7. Rencana uji `anchor test`

11 kasus sudah ada di `programs/vin-anchor/tests/vin_anchor.ts` (termasuk 2 uji regresi). Fase 1
menambah:

| # | Kasus | Membuktikan invarian |
| --- | --- | --- |
| 12 | Dua pembeli membuka deal untuk `vin_hash` yang sama → deal kedua ditolak | 1 |
| 13 | Laporan 50.000 setelah rekor 90.000 → `anomaly_pending`, `accept_report` ditolak sampai di-acknowledge | 2 |
| 14 | Setelah laporan rendah 50.000, laporan 60.000 **tetap** anomali (baseline = 90.000) | 2 |
| 15 | `release_leg` sebelum `HandoverConfirmed` → revert | 3 |
| 16 | `release_leg` saat `Frozen` → revert | 3 |
| 17 | Urutan acak (properti): semua urutan di luar `DEAL_ORDER` ditolak | 8 |
| 18 | `record_note` dua kali → gagal (akun sudah ada) | 5 |
| 19 | `resolve_dispute` dengan pembagian tidak tepat habis → revert | 4 |

**Status (ditulis).** Kasus 15 (`release_leg` sebelum `HandoverConfirmed`) dan 17 (properti urutan
di luar `DEAL_ORDER`) kini ada di `tests/vin_anchor.ts`; kasus 12–14 ada di `tests/vin_registry.ts`.
Kasus 16 sudah tercakup kasus 6 (deal beku menolak `release_leg`), kasus 18 oleh pemeriksaan idempoten
di dalam kasus 10 (`record_note` kedua ditolak), dan kasus 19 oleh kasus 7 (split tidak tepat habis).
Kasus 5, 10, dan 11 ikut diperbarui agar menapaki alur `DealState` yang baru (laporan → terima →
handover → konfirmasi) sebelum dana lepas. Semua file lulus pemeriksaan sintaks TypeScript; eksekusi
hijau penuh tetap lewat CI karena butuh IDL (lihat §10).

Kasus 12 dan 14 adalah **pembuktian langsung** dua bug logika yang sekarang sudah ditutup di API;
Fase 1 harus menutupnya di on-chain juga.

## 8. Definisi selesai (Fase 1)

- [x] `DealState` menggantikan tiga bool; tabel transisi `DEAL_ORDER` dikodekan di Rust lewat
      `require_state`, plus empat instruksi tahap-deal (`submit_report`, `accept_report`,
      `mark_handover`, `confirm_handover`). `release_leg` kendaraan wajib `HandoverConfirmed`;
      `record_note` wajib `Released`. Type-check hijau via `cargo check` host + `anchor build --no-idl`.
- [x] `VinRecord` + sembilan instruksi registry diimplementasikan di `lib.rs` (aditif: init_vin_record,
      record_listing, record_reserve, release_reserve, record_inspection, acknowledge_anomaly,
      record_completion, record_dispute, record_resolution). Type-check hijau via `cargo check` host; SBF/devnet lewat CI.
- [x] Gerbang `max_odometer` (high-water) dan `anomaly_pending` di on-chain, plus event `OdometerAnomaly`.
- [x] Kasus uji 1–19 **ditulis** dan lulus pemeriksaan sintaks TypeScript: kasus 1–11, 15, 17 di
      `tests/vin_anchor.ts`; kasus 12–14 di `tests/vin_registry.ts`; kasus 16 tercakup kasus 6,
      kasus 18 oleh pemeriksaan idempoten di kasus 10, kasus 19 oleh kasus 7.
- [x] Kasus uji 1–19 **hijau saat dijalankan** di CI (localnet, kedua file test dijalankan sekaligus):
      17 test, 17 lulus — run `37395502737` pada commit `21d8c41`. Sebelumnya run `37394675529`
      pada `f6178bd` merah (14 lulus, 3 gagal); penyebab dan perbaikannya ada di §11.
- [x] `anchor build && anchor test` **penuh** hijau di CI (`.github/workflows/anchor.yml`), termasuk
      gerbang frame SBF. Bukti: run `37395502737` (job `anchor build + anchor test`: success).
- [ ] `declare_id!` diganti dengan program ID devnet yang sebenarnya (sekarang masih placeholder
      `anchor init`; `tests/*.ts` memakai ID yang sama agar konsisten di localnet).
- [ ] `AnchorEscrowProvider` di `services/api/src/escrow.ts` diimplementasikan, dan smoke test
      dijalankan ulang terhadap devnet. **Ditunda** — bergantung pada deploy devnet + IDL hasil
      `anchor build` penuh; sampai itu ia sengaja tetap stub agar tidak ada klaim palsu bahwa dana
      benar-benar on-chain.

## 9. Yang TIDAK termasuk Fase 1

Sengaja ditunda supaya permukaan audit tetap kecil:

- Pemisahan enam kontrak (`StakeVault`, `AccessController`, `VinRegistry`) — itu Fase 2.
- `FeeCollector` terpisah dan mekanisme burn — itu Fase 3, dan baru masuk akal setelah ada fee nyata.
- Peran berbatas waktu dan arbiter 2-dari-3 — Fase 2.
- KYC/KYB vendor, izin penyelenggara, dan audit pihak ketiga — prasyarat mainnet, bukan Fase 1.

## 10. Catatan lingkungan

Status toolchain (diperbarui): WSL Ubuntu punya `solana-cli`, `anchor-cli 0.30.1`, dan `rustc 1.88`
host. Seluruh program (DealState + registry) **type-check hijau** lewat `cargo check` host, dan
**`anchor build --no-idl` hijau** — program ter-compile ke SBF (`vin_anchor.so`, 0 error, hanya
warning `cfg(anchor-debug)` yang jinak). Blocker lama `edition2024`/lockfile sudah ditangani:
`programs/vin-anchor/Cargo.toml` kini menetapkan `rust-version = "1.75"` sehingga resolver cargo yang
sadar-MSRV (`resolver.incompatible-rust-versions = "fallback"`) memilih versi crate yang kompatibel
dengan `rustc` platform-tools SBF. Repo tetap **tidak** meng-commit `Cargo.lock` agar CI me-resolve
segar dengan toolchain-nya sendiri.

Yang **belum** hijau di mesin ini: tahap generasi **IDL** pada `anchor build` penuh — penyebabnya di
luar kode kita. Proc-macro `MontFp!` milik `ark-bn254` gagal di-parse oleh host `rustc 1.88`,
sedangkan `rustc ≤ 1.79` terlalu tua untuk sebagian dependensi IDL (`rayon-core`, `wasm-bindgen`).
Karena `tests/*.ts` meng-import IDL + types hasil build itu (`target/idl` + `target/types`),
**`anchor test` penuh dijalankan di CI** dengan toolchain yang serasi (Solana `v4.3.0` + `rustc
1.99.0`, lihat `.github/workflows/anchor.yml`), bukan di mesin ini.

Yang harus dijalankan di mesin/CI dengan platform-tools yang cocok:

```bash
cd programs/vin-anchor
anchor build
anchor test            # atau: anchor test --skip-build setelah build
```

Selama perintah itu belum hijau, **jangan** mengklaim apa pun tentang dana on-chain — termasuk di
dokumentasi pemasaran.

Catatan: sejak `21d8c41`, CI sudah **hijau penuh** untuk `anchor build` + `anchor test` (run
`37395502737`, 17/17 test). Yang masih terblokir hanya di mesin WSL ini (generasi IDL karena
proc-macro `ark-bn254` vs host `rustc 1.88`), bukan di CI.

## 11. Regresi yang tertangkap CI (dan pelajarannya)

Run CI pertama untuk refactor `DealState` (`f6178bd`) **merah**: 14 lulus, 3 gagal. Akarnya satu
baris yang hilang. Refactor mengubah tiga bool (`frozen`, `completed`, `cancelled`) menjadi enum,
dan `require!(!deal.frozen, DealFrozen)` di `release_leg` diganti dengan padanan state-nya — tetapi
di `refund_leg` penggantinya (`state != Noted && state != Cancelled`) justru **mengizinkan** Frozen.

Akibatnya: saat sengketa terbuka, relayer bisa mengembalikan dana ke pembeli, mengosongkan vault,
dan membuat deal menjadi `Cancelled` sebelum arbiter memutus — persis lubang yang dijaga test 6
("a frozen deal rejects release_leg AND refund_leg"). Test 7 dan 8 gagal sebagai **efek berantai**
dari refund nyasar itu (state sudah `Cancelled`, sehingga `resolve_dispute` → `OutOfOrder`), jadi
tidak ada asersi yang perlu dilunakkan.

Perbaikan (`21d8c41`) mengembalikan satu gerbang itu di `refund_leg`, sejajar dengan `release_leg`.
Semua `require!` yang dihapus refactor diaudit satu per satu dan dipetakan ke penggantinya; hanya
yang ini yang tidak punya padanan:

| `require!` lama | Fungsi lama | Padanan baru |
| --- | --- | --- |
| `!deal.frozen` | `fund_leg` | `!dispute_open` + `require_state(Reserved/Funded)` (lebih ketat) |
| `!deal.frozen` | `release_leg` | `!dispute_open && state != Frozen` |
| `!deal.frozen` | `refund_leg` | **hilang → dikembalikan di `21d8c41`** |
| `deal.frozen` | `resolve_dispute` | `require_state(Frozen)` |
| `completed \|\| cancelled` | `record_note` | `require_state(Released)` |

Pelajaran yang saya pakai lagi ke depan: saat mengubah representasi state, petakan **setiap**
`require!` yang hilang ke penggantinya, dan biarkan CI menjalankan suite — bukan hanya type-check.
Sisa celah sejenis berikutnya (belum diperbaiki, keputusan pemilik): `refund_leg` tidak dibatasi
oleh state, sehingga refund setelah `HandoverConfirmed` masih mungkin; sebelum itu diubah, tambahkan
test-nya lebih dulu.
