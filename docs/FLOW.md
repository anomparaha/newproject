# Alur smart contract VIN — apa yang sebenarnya terjadi on-chain

Dokumen ini menjawab satu pertanyaan: **kalau program Anchor ini berjalan, uang bergerak bagaimana,
siapa memanggil apa, dan apa yang dijaga.**

> Status: alur di bawah adalah **rancangan yang sudah dikodekan** di `programs/vin-anchor/src/lib.rs`.
> Program belum dikompilasi/di-deploy, dan API saat ini masih memakai `MockEscrowProvider`.
> Jadi ini "alur yang siap", bukan "alur yang sedang berjalan". Lihat `docs/PROGRAM.md` §7.

---

## 1. Siapa memegang kunci apa

| Pemegang | Kunci | Boleh memanggil | Tidak boleh |
| --- | --- | --- | --- |
| **Admin** (rencana: multisig Squads) | `admin` | `initialize_config`, `set_authorities`, `revoke_actor` | Menyentuh dana deal |
| **Relayer** (hot key platform) | `relayer` | `release_leg`, `refund_leg`, `return_bond`, `record_note` | Mengubah tujuan fee, mengabaikan pembekuan, melebihi batas bps |
| **Arbiter** | `arbiter` | `resolve_dispute`, `slash_bond` | Melepas dana tanpa sengketa |
| **Pembeli** | dompet pembeli | `open_deal`, `fund_leg`, `freeze_deal` | Menarik dana kembali sepihak |
| **Penjual / Bengkel** | dompet masing-masing | `register_actor`, `lock_bond`, `freeze_deal` | Melepas dana ke diri sendiri |

Tidak ada satu pun instruksi yang mengirim dana ke `admin`. Fee platform selalu ke
`config.fee_treasury`; potongan jaminan selalu ke `dispute_fund`.

## 2. Akun dan PDA

| Akun | Seeds | Fungsi |
| --- | --- | --- |
| `Config` | `["config"]` | admin, arbiter, relayer, `fee_treasury`, `dispute_fund`, bps fee, `paused` |
| `dispute_fund` | `["dispute_fund"]` | Kas sengketa (token account) |
| `ActorAccount` | `["actor", wallet]` | peran, hash attestation, `revoked`, `bond_locked` |
| Bond vault | `["bond_vault", actor]` | Jaminan terkunci (authority = PDA aktor) |
| `DealAccount` | `["deal", vin_hash, buyer]` | jumlah terkunci, jumlah terlepas, `frozen`/`cancelled`/`completed`, `evidence_root` |
| `vehicle_vault` | `["vault", deal, 0]` | **Dana kendaraan** (authority = PDA deal) |
| `inspection_vault` | `["vault", deal, 1]` | **Dana inspeksi** (authority = PDA deal) |
| `NoteAccount` | `["note", deal, note_seq]` | `owner`, `evidence_root`, `asset` (Metaplex Core), `created_at` |

Pemisahan `vehicle_vault` dan `inspection_vault` adalah keputusan keamanan, bukan kerapian:
satu bug atau satu jalur yang salah tidak boleh bisa menyentuh dana kendaraan.

## 3. Alur bahagia (happy path)

```
PENDAFTARAN (sekali per aktor)
  penjual  ── register_actor(role=1, attestation) ──►  ActorAccount penjual
  bengkel  ── register_actor(role=2, attestation) ──►  ActorAccount bengkel
  bengkel  ── lock_bond(amount, purpose=1) ─────────►  BondVault bengkel
                                                       (wajib sebelum menerima order)

DEAL (per transaksi kendaraan)
  pembeli  ── open_deal(vin_hash, vehicle_amt, inspection_amt) ─►
                ├─ DealAccount dibuat
                ├─ vehicle_vault dibuat     (kosong)
                └─ inspection_vault dibuat  (kosong)
                syarat: bengkel.bond_locked > 0, tak ada aktor revoked, program tidak paused

  pembeli  ── fund_leg(0, vehicle_amt) ─────► vehicle_vault    (USDC pembeli → vault)
  pembeli  ── fund_leg(1, inspection_amt) ──► inspection_vault (USDC pembeli → vault)
                syarat: saldo vault + amount ≤ jumlah yang dikunci (OverFunded ditolak)

  ─── OFF-CHAIN: bengkel memeriksa unit, mengunggah laporan ke API (hash saja) ───

  relayer  ── release_leg(1, amount, evidence_hash, fee) ─►
                ├─ inspection_vault → akun bengkel (dikurangi fee)
                └─ inspection_vault → fee_treasury (fee)
                syarat: tidak frozen/selesai/dibatalkan, ≤ sisa leg, fee ≤ bps

  ─── OFF-CHAIN: syarat serah terima dipenuhi (bukti muat / serah di lokasi / konfirmasi dua pihak) ───

  relayer  ── release_leg(0, amount, evidence_hash, fee) ─►
                ├─ vehicle_vault → akun penjual
                └─ vehicle_vault → fee_treasury
                KEIKA KEDUA LEG TUNTAS: deal.completed = true   ← ini yang membuka nota

  relayer  ── record_note(owner=pembeli, note_seq, evidence_root, asset) ─►
                NoteAccount PDA dicatat (hanya hash + alamat aset)
                syarat: deal.completed || deal.cancelled, owner = pembeli/penjual
                        nomor nota tidak bisa ditimpa (init, bukan init_if_needed)
```

Hasil akhir: kedua vault **nol**. Tidak ada dana menganggur di dalam program.

## 4. Alur sengketa

```
  pembeli/penjual/bengkel ── freeze_deal(reason_hash) ──►  deal.frozen = true
        Setelah ini:
          release_leg  DITOLAK (DealFrozen)
          refund_leg   DITOLAK (DealFrozen)   ← temuan review; dulu bisa dipakai
                                                relayer untuk melewati arbitrase

  ─── OFF-CHAIN: arbitrase memeriksa event log (laporan, hash, riwayat kilometer) ───

  arbiter ── resolve_dispute(decision, to_buyer, to_seller, to_inspector, evidence_hash)
        Akuntansi WAJIB TEPAT HABIS:
          leg kendaraan : to_buyer + to_seller == sisa leg kendaraan
          leg inspeksi  : to_inspector ≤ sisa; sisanya otomatis kembali ke pembeli
        Sesudah transfer, program MEMERIKSA kedua leg == nol (InexactSettlement bila tidak)
        Hasil: decision refund/bond_slashed → cancelled; selain itu → completed

  arbiter ── slash_bond(amount, evidence_hash) ──►  bond_vault → dispute_fund
        Tidak pernah ke admin/relayer. Kas sengketa untuk kompensasi.
```

| decision | arti | leg kendaraan | leg inspeksi |
| --- | --- | --- | --- |
| 0 `refund_buyer` | dana kembali ke pembeli | seluruh sisa → pembeli | bengkel dibayar bila laporan ada; sisanya → pembeli |
| 1 `release_to_seller` | dana dilepas ke penjual | seluruh sisa → penjual | idem |
| 2 `split` | sebagian-sebagian | `to_buyer` + `to_seller` = sisa | idem |
| 3 `bond_slashed` | penjual gagal + jaminan dipotong | seluruh sisa → pembeli | idem |

## 5. Pembatalan sebelum serah terima

```
  relayer ── refund_leg(leg, evidence_hash) ─► sisa leg kembali ke pembeli
        syarat: TIDAK frozen, TIDAK completed, TIDAK cancelled
        Bila kedua leg sudah kembali → deal.cancelled = true (nota boleh dicatat
        sebagai deal yang dibatalkan, bukan sebagai deal selesai)
```

## 6. Yang benar-benar dijaga program (dan yang tidak)

**Dijaga oleh program (tidak bisa dilanggar siapa pun):**

- Dana kendaraan dan dana inspeksi tidak pernah bercampur (vault berbeda).
- Tidak ada yang bisa menarik dana melebihi jumlah yang dikunci (`OverRelease`).
- Relayer tidak bisa melepas dana saat sengketa berjalan (`DealFrozen`).
- Fee hanya ke alamat treasury yang dikunci di `Config`, dan tidak melebihi bps.
- Potongan jaminan hanya ke kas sengketa.
- Arbiter wajib menyelesaikan sampai nol — tidak boleh menyisakan dana.
- Nota hanya dicatat setelah deal ditutup, dan tidak bisa ditimpa.
- Hanya arbiter yang memutuskan; hanya pihak dalam deal yang boleh membekukan.

**TIDAK dijaga program (dan harus disadari):**

| Hal | Kenapa | Di mana dijaga |
| --- | --- | --- |
| Apakah syarat serah terima benar-benar terpenuhi | Program hanya menyimpan `evidence_hash`; ia tidak bisa melihat "bukti muat" atau konfirmasi dua pihak | API: `vehicleReleasePreconditions()` + event log |
| Apakah laporan inspeksi benar isinya | Laporan mentah off-chain (foto tidak bisa masuk chain) | Standar laporan + jaminan + reputasi + spot-check kurator |
| Apakah nomor rangka itu benar unitnya | Butuh pemeriksaan fisik & dokumen negara asal | Bengkel + kurator + dokumen resmi |
| Niat relayer | Relayer boleh memilih kapan memanggil `release_leg` | Pembatas: `freeze_deal` kapan saja oleh pihak deal, arbiter bisa memutus, batas bps, treasury terkunci, dan (rencana) batas harian + multisig |
| Hukum & pajak | Di luar jangkauan kode | `docs/LEGAL.md` |

Singkatnya: **program menjamin mekanika kustodi uang, bukan kebenaran fakta.** Fakta berasal dari
event log off-chain yang bisa diaudit; kekuatan program adalah membuat pihak yang memegang kunci
tidak bisa menyimpang dari aturan yang sudah dikunci.

## 7. Kenapa ada relayer (dan risikonya)

Ekosistem tidak bisa menuntut pembeli/penjual mengirim transaksi on-chain manual untuk setiap langkah
(mereka mungkin memakai fiat, tidak punya SOL, atau memakai perangkat sederhana). Karena itu ada
**satu hot key platform (relayer)** yang mengeksekusi pelepasan dana berdasarkan event log.

Konsekuensinya harus jujur diakui: relayer adalah titik kepercayaan. Yang membatasinya:

1. **Batas keras di program** — tidak bisa melebihi jumlah terkunci, tidak bisa melewati pembekuan,
   fee tidak bisa dibelokkan, tidak bisa menyentuh kas sengketa.
2. **Pembekuan sepihak** — pembeli, penjual, atau bengkel bisa `freeze_deal` kapan saja dan menghentikan relayer.
3. **Arbitrase** — satu-satunya jalan keluar setelah beku, dan wajib tepat habis.
4. **Bukti yang tercatat** — setiap pelepasan menyertakan `evidence_hash`; itulah yang diaudit.
5. **Rencana berikutnya** — batas harian pelepasan, multisig untuk admin, alarm anomali, dan audit.

Kalau mau menghapus kepercayaan pada relayer sepenuhnya, langkah berikutnya adalah membuat
syarat pelepasan bisa dibuktikan on-chain (mis. tanda tangan dua pihak, atau attestation oracle).
Itu pekerjaan besar dan belum dilakukan.

## 8. Peta ke kode

| Langkah | Instruksi Rust | Uji properti (TS) | Uji Anchor |
| --- | --- | --- | --- |
| Jaminan bengkel | `lock_bond` | — | #2, #11 |
| Deal dibuka | `open_deal` | `openDeal` | #1, #2 (BondRequired) |
| Pendanaan | `fund_leg` | `fundLeg` | #3 (OverFunded), #4 |
| Pelepasan inspeksi | `release_leg(1, …)` | `releaseLeg` | #5 |
| Pelepasan kendaraan | `release_leg(0, …)` | `releaseLeg` | #10 |
| Deal selesai | (otomatis) | invarian 8 | #10 |
| Sengketa | `freeze_deal` | `freezeDeal` | #6 (regresi) |
| Putusan | `resolve_dispute` | `resolveDispute` | #7, #8 |
| Jaminan dipotong | `slash_bond` | `slashBondToDisputeFund` | #9 |
| Nota | `record_note` | `canRecordNote` | #10, #11 |
| Pembatalan | `refund_leg` | `refundLeg` | #6 (regresi) |

Cara menjalankan:

```bash
npm test                                     # aturan: 22 uji (jalan sekarang)
cd programs/vin-anchor && anchor build && anchor test   # implementasi: 11 kasus
```

## 9. Yang berubah di alur ini karena review terakhir

| Temuan | Sebelum | Sesudah |
| --- | --- | --- |
| `refund_leg` mengabaikan `frozen` | Relayer bisa mengembalikan dana saat sengketa → pembekuan tak bermakna | Ditolak `DealFrozen` (uji regresi #6) |
| Fee tanpa tujuan tetap | Relayer bisa mengarahkan fee ke dompetnya | `fee_treasury` dikunci di `Config` + constraint akun |
| `resolve_dispute` boleh menyisakan dana | Sisa menganggur; bengkel tak dibayar saat deal dibatalkan | Wajib tepat habis; sisa leg inspeksi → pembeli |
| `release_leg` tak pernah menandai `completed` | **Nota tidak akan pernah bisa dicatat** di jalur bahagia | `completed` diisi saat kedua leg tuntas (uji #10) |
| `record_note` pakai `init_if_needed` | Nota bisa ditimpa | `init`: satu nomor nota, sekali saja |
