# Program Solana VIN (`programs/vin-anchor`)

Referensi smart contract VIN: apa yang sudah dibuat, apa yang dijaga, dan apa yang **belum**.

> **Status jujur:** program **sudah dikompilasi** dan test suite **sudah berjalan** di GitHub
> Actions (SBF build + IDL + validator lokal), tetapi **baru 1 dari 11 skenario yang lulus**, dan
> **belum pernah di-deploy** ke devnet/mainnet. Sandbox pengembangan ini tidak bisa memasang
> Rust/crates.io (host `static.rust-lang.org`, `crates.io`, dan semua mirror diblokir; hanya npm,
> PyPI, dan GitHub terbuka), jadi kompilasi dan test hanya bisa dijalan-kan lewat CI atau di mesin
> yang punya toolchain — resepnya di `docs/LOCAL_TEST.md`. Sampai suite-nya hijau, **tidak ada satu
> pun klaim dana on-chain yang boleh dibuat.**

---

> **Alur langkah demi langkah** (siapa memanggil apa, urutan, penjagaan tiap langkah, dan apa yang
> tidak dijaga program): **`docs/FLOW.md`**.

## 1. Ringkas

| | |
| --- | --- |
| Program id (placeholder) | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` — ganti dengan hasil `anchor build` |
| Framework | Anchor `0.30.1`, `anchor-lang` + `anchor-spl` |
| Token | SPL Token (USDC). Token-2022 didukung dengan mengganti `token_program` |
| Akun state | `Config`, `ActorAccount`, `DealAccount`, `NoteAccount` |
| Instruksi | 14 (lihat §3) |
| Dependensi opsional | `mpl-core` untuk mencetak NFT nota langsung dari program (fitur `metaplex-core`, nonaktif default) |
| Uji siap-jalan | `programs/vin-anchor/tests/vin_anchor.ts` — 11 kasus, termasuk 2 uji regresi |
| CI | `.github/workflows/anchor.yml` (Rust + Solana CLI + Anchor, `anchor build`, `anchor test`) |

## 2. Akun dan PDA

| Akun | Seeds | Isi |
| --- | --- | --- |
| `Config` | `["config"]` | `admin`, `arbiter`, `relayer`, `fee_treasury`, `dispute_fund`, `fee_bps_vehicle`, `fee_bps_inspection`, `paused` |
| `dispute_fund` (token account) | `["dispute_fund"]` | Kas sengketa; **satu-satunya** tujuan potongan jaminan |
| `ActorAccount` | `["actor", wallet]` | `role`, `attestation` (hash 32 byte), `revoked`, `bond_locked` |
| Bond vault | `["bond_vault", actor]` | Jaminan yang terkunci, authority = PDA aktor |
| `DealAccount` | `["deal", vin_hash, buyer]` | dua jumlah terkunci, dua jumlah terlepas, `frozen`/`cancelled`/`completed`, `evidence_root` |
| Vault kendaraan | `["vault", deal, 0]` | Dana kendaraan. **Terpisah dari** |
| Vault inspeksi | `["vault", deal, 1]` | ...dana inspeksi |
| `NoteAccount` | `["note", deal, note_seq]` | `owner`, `evidence_root`, `asset` (alamat Metaplex Core), `created_at` |

Yang on-chain hanya **hash dan alamat**. VIN penuh, foto, laporan, dan identitas pelaku tetap off-chain
(`anchorPayloadHash` di `packages/shared/src/schema.ts`).

## 3. Instruksi

| # | Instruksi | Siapa yang boleh | Yang dijaga |
| --- | --- | --- | --- |
| 1 | `initialize_config` | admin | bps fee ≤ 10%; `fee_treasury` dikunci di akun Config |
| 2 | `set_authorities` | admin (multisig) | mengubah relayer/arbiter/treasury, `paused` |
| 3 | `register_actor` | siapa pun (bayar sendiri) | peran 0–4; menyimpan hash attestation identitas |
| 4 | `revoke_actor` | admin | aktor dicabut tidak bisa membuka deal/mengunci jaminan |
| 5 | `lock_bond` | aktor | jaminan dalam stablecoin, masuk bond vault milik PDA aktor |
| 6 | `return_bond` | relayer | jaminan kembali setelah deal bersih, dengan hash alasan |
| 7 | `open_deal` | pembeli | bengkel **wajib** sudah mengunci jaminan; membuat dua vault sekaligus |
| 8 | `fund_leg` | pembeli | dana masuk tidak boleh melebihi jumlah yang dikunci (`OverFunded`) |
| 9 | `freeze_deal` | pembeli / penjual / bengkel | membekukan deal; selain ketiganya ditolak |
| 10 | `release_leg` | relayer | ditolak bila beku/selesai/dibatalkan; tidak boleh melebihi sisa leg; fee ≤ bps; fee hanya ke `fee_treasury` |
| 11 | `refund_leg` | relayer | **ditolak bila beku** (temuan review §6.2); tidak bisa refund ganda |
| 12 | `resolve_dispute` | arbiter | akuntansi wajib **tepat habis**; kedua vault harus nol setelahnya |
| 13 | `slash_bond` | arbiter | potongan jaminan hanya ke kas sengketa |
| 14 | `record_note` | relayer | hanya setelah deal ditutup; satu nomor nota **tidak bisa ditimpa** |

## 4. Invarian dan di mana dijaga

| Invarian | Rust | Model ledger (TS, sudah diuji di sini) |
| --- | --- | --- |
| Pelepasan tidak melebihi jumlah terkunci | `release_leg` → `OverRelease` | `releaseLeg()` + uji properti #1 |
| Deal beku menolak semua perpindahan | `release_leg`, `refund_leg` → `DealFrozen` | uji properti #2 |
| Putusan arbiter tepat habis (nol sisa) | `resolve_dispute` → `InexactSettlement` | uji properti #3, #3b |
| Potongan jaminan → kas sengketa | `slash_bond` | uji properti #4 |
| Hanya arbiter memutus; hanya pihak deal membekukan | `require!` pada `Signer` | uji properti #5 |
| Refund tidak bisa dua kali | `refund_leg` (sisa dihitung) | uji properti #6 |
| Fee ≤ bps dan hanya ke treasury | `release_leg` + constraint akun | uji properti #7 |
| Pembukuan selalu nol (double-entry) | saldo vault = jumlah terkunci − terlepas | `ledgerSumsToZero()` |

Model ledger TypeScript **bukan** program on-chain — ia adalah spesifikasi yang bisa dieksekusi.
Menjalankannya membuktikan *aturan*-nya; `anchor test` membuktikan *implementasinya*. Keduanya
memakai angka dan skenario yang sama supaya perbedaannya langsung terlihat.

```bash
# Aturan (jalan sekarang, tanpa toolchain Solana)
npm test        # 22 uji: 11 aturan inti + 11 uji properti/skenario ledger

# Implementasi (butuh toolchain Solana)
cd programs/vin-anchor && anchor build && anchor test
```

## 5. Model ancaman singkat

| Serangan | Pertahanan di program |
| --- | --- |
| Relayer mencuri dengan melepas dana | Butuh hash bukti; tidak bisa melebihi sisa leg; arbiter bisa membekukan; treasury fee dikunci di Config |
| Relayer melewati arbitrase saat sengketa | `refund_leg`/`release_leg` menolak deal beku (temuan §6.2) |
| Relayer mengarahkan fee ke dompetnya | Constraint `token::authority = config.fee_treasury` (§6.1) |
| Arbiter menggelapkan sisa dana | Wajib tepat habis; kedua vault harus nol setelah putusan (§6.3) |
| Penjual mengubah aturan setelah dana masuk | Jumlah terkunci di `DealAccount`; event lama tidak bisa ditimpa |
| Bengkel memberi laporan palsu | Jaminan + reputasi off-chain; hash laporan tidak bisa diubah; `freeze_deal` |
| Akun boneka / identitas palsu | `ActorAccount.attestation` + `revoked`; kurator off-chain yang menerbitkan |
| Admin jahat | (rencana) multisig + timelock; hari ini **belum ada** — jangan mainnet sebelum ini beres |
| Upgrade paksa program | (rencana) upgrade authority di multisig; saat ini wallet tunggal |

## 6. Temuan review dan perbaikannya

Tiga hal ditemukan saat menelaah ulang dan sudah diperbaiki di kode.

**6.1 Fee bisa diarahkan ke dompet relayer.**
Sebelumnya `release_leg` menerima `fee_destination: Pubkey` dan hanya membandingkannya dengan akun
yang dikirim pemanggil — perbandingan tanpa makna. Diperbaiki: `fee_treasury` disimpan di `Config`
saat inisialisasi, dan akun penerima fee diberi constraint `token::authority = config.fee_treasury`.

**6.2 `refund_leg` bisa mem-bypass pembekuan sengketa (paling serius).**
`refund_leg` tidak memeriksa `deal.frozen`, sehingga relayer bisa mengembalikan dana sebelum arbiter
memutuskan — pembekuan sengketa jadi tidak bermakna. Ditemukan oleh **uji properti model ledger**
(counterexample minimal: freeze lalu refund diterima), bukan oleh pembacaan manual. Diperbaiki di
Rust dan di model, lalu dikunci sebagai uji regresi (kasus #6 di `tests/vin_anchor.ts`).

**6.3 Putusan arbitrase bisa meninggalkan dana tersangkut.**
`resolve_dispute` versi awal hanya memeriksa `jumlah ≤ sisa`, sehingga sisa bisa tertinggal di vault
tanpa pemilik, dan leg inspeksi bisa tidak dibayar sama sekali. Diperbaiki: keputusan menentukan pola
pembagian, jumlahnya wajib tepat habis, dan sisa leg inspeksi otomatis kembali ke pembeli.

## 7. Yang belum ada (jangan mainnet sebelum ini selesai)

- [ ] `anchor build` + `anchor test` benar-benar dijalankan dan hijau (lihat workflow).
- [ ] Audit pihak ketiga; temuan diperbaiki dan diverifikasi ulang.
- [ ] Multisig (Squads) sebagai admin + upgrade authority, dengan timelock.
- [ ] Batas harian pelepasan dana dan alarm anomali untuk relayer.
- [ ] Uji properti on-chain (fuzzing kelipatan dari versi TypeScript).
- [ ] Uji integrasi end-to-end dengan RPC nyata di devnet, termasuk webhook pendanaan.
- [ ] Rekonsiliasi harian: event log ⇄ escrow provider ⇄ saldo on-chain.
- [ ] Rename `declare_id!` ke program id hasil build, dan `initialize_config` dijalankan dengan
      alamat treasury + arbiter yang sebenarnya.
- [ ] Keputusan hukum atas jaminan token sebelum `lock_bond` dipakai dengan nilai nyata (`docs/LEGAL.md`).

## 8. Cara mengaktifkan di API

Program ini dipakai lewat implementasi `EscrowProvider` yang sama dengan mock:

```ts
// services/api/src/app.ts
const ctx = {
  db,
  escrow: new MockEscrowProvider(db),                     // sekarang
  // escrow: new AnchorEscrowProvider(rpcUrl, programId), // setelah deploy
};
```

`AnchorEscrowProvider` sengaja **melempar error** selama `VIN_ESCROW_PROGRAM_ID` belum diset, supaya
tidak ada klaim dana on-chain yang tidak benar. Lihat `docs/DEPLOYMENT.md` §4.
