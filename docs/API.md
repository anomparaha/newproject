# Referensi API VIN

Dasar: `http://localhost:8080/api` (produksi: domain API internal; frontend memakai rewrite `/api/*`).

**Autentikasi:** Sign-In With Solana. Wallet menandatangani nonce sekali pakai, lalu setiap
permintaan menulis membawa `Authorization: Bearer <token>`.
**Demo:** header `x-actor-id: <actor_id>` masih berlaku selama `VIN_DEMO_MODE ≠ false`
(untuk seed, smoke test, dan koleksi Postman). Saat `VIN_DEMO_MODE=false` header itu ditolak.
Detail: `docs/SIWS.md`.

Semua respons error berformat:

```json
{ "error": { "code": "INVALID_TRANSITION", "message": "...", "details": {} } }
```

---

## Meta & kebijakan

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| GET | `/health` | Status layanan, provider escrow, tahap saat ini |
| GET | `/meta/policy` | Fee, jaminan, kapasitas, utilitas token, tahapan, taksonomi event, ambang berhenti perluasan |
| GET | `/metrics/token` | Jaminan terkunci, jaminan terpotong/kembali, catatan metrik |
| GET | `/demo/actors` | Daftar aktor demo (mati bila `VIN_DEMO_MODE=false`) |

## Aktor

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| POST | `/actors` | Daftar aktor (`buyer`/`seller`/`inspector`/`curator`/`arbiter`) |
| GET | `/actors?role=&country=` | Cari aktor |
| GET | `/actors/:id` | Detail + jaminan + reputasi |
| POST | `/actors/:id/verify` | Kurator memverifikasi identitas usaha (`basic`/`business_verified`/`suspended`) |
| POST | `/actors/:id/bonds` | Kunci jaminan (`listing`/`inspection_capacity`) |
| POST | `/actors/:id/affiliations` | Catat afiliasi penjual–bengkel (kurator) |
| GET | `/actors/:id/affiliations` | Daftar afiliasi |

## Koridor

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| GET | `/corridors` | Koridor aktif + koridor kandidat yang belum dilayani |
| POST | `/corridors` | Buka koridor (kurator). Ditolak bila koridor lama belum sehat |
| GET | `/corridors/:id/metrics` | Metrik publik + 4 angka pemicu berhenti perluasan |

## Listing & VIN

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| POST | `/listings` | Buat listing. Di atas ambang nilai: wajib verifikasi + jaminan |
| GET | `/listings?status=&vin=&sellerId=` | Daftar listing |
| GET | `/listings/:id` | Detail listing + penjual + batas VIN |
| PATCH | `/listings/:id` | Ubah listing **sebelum ada pembeli**; dicatat sebagai event baru |
| GET | `/vin/:vin` | Rangkaian event, laporan, nota, anomali, batas klaim |

## Deal, inspeksi, dana

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| POST | `/listings/:id/deals` | Pembeli mengunci deal; membuat dua escrow terpisah |
| POST | `/deals/:id/fund` | Konfirmasi pendanaan (produksi: webhook penyedia) → event `deal_committed` |
| POST | `/deals/:id/reports` | Bengkel mengunggah laporan (hash + checklist standar) |
| POST | `/deals/:id/reports/:reportId/accept` | Pembeli menerima laporan → dana inspeksi lepas |
| POST | `/deals/:id/handover` | Konfirmasi serah terima per pihak |
| POST | `/deals/:id/release-vehicle` | Lepas dana kendaraan + catat nota (butuh syarat terpenuhi) |
| GET | `/deals?actorId=&state=` | Daftar deal |
| GET | `/deals/:id` | Detail deal: escrow, laporan, sengketa, nota, pihak, event |
| GET | `/deals/:id/escrows` | Dua leg escrow |

## Sengketa

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| POST | `/deals/:id/disputes` | Buka sengketa → membekukan escrow dan nota |
| POST | `/disputes/:id/resolve` | Arbiter memutuskan: `refund_buyer`, `release_to_seller`, `split`, `bond_slashed` |

## Reputasi & nota

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| GET | `/inspectors?country=` | Pasar inspeksi, diurutkan dari kinerja (ranking tidak dijual) |
| GET | `/reputation/:actorId` | Hitung ulang reputasi dari event |
| GET | `/notes?ownerId=&vin=` | Nota yang dimiliki aktor |
| GET | `/notes/:id/metadata` | Metadata nota kompatibel Metaplex Core |

---

## Contoh: alur lengkap dengan curl

```bash
API=http://localhost:8080/api
SELLER=act_xxx ; BUYER=act_yyy ; INSP=insp_zzz ; LISTING=lst_aaa

# 1. Penjual membuat listing dengan jaminan
curl -s -X POST $API/listings -H 'content-type: application/json' -H "x-actor-id: $SELLER" -d '{
  "vin":"JTDKAMFU1M3123456","sellerId":"'"$SELLER"'","make":"Toyota","model":"Alphard",
  "year":2021,"odometerKm":30000,"location":"Dubai","priceAmount":"45000","priceCurrency":"USDC",
  "shippingTerms":"FOB Jebel Ali","photoHashes":["'$(openssl rand -hex 32)'"],
  "bond":{"amount":"50","currency":"USDC"}}'

# 2. Pembeli mengunci deal
curl -s -X POST $API/listings/$LISTING/deals -H 'content-type: application/json' -H "x-actor-id: $BUYER" -d '{
  "buyerId":"'"$BUYER"'","inspectorId":"'"$INSP"'","shippingPaidBy":"buyer","shippingAmount":"1200",
  "inspectionFeeAmount":"150","escrowCurrency":"USDC","inspectionDeadlineHours":72,
  "handoverTerms":"Serah di lokasi + bukti muat; konfirmasi kedua pihak"}'

# 3. Pendanaan escrow, laporan, penerimaan, serah terima, pelepasan: lihat README §3
```

## Autentikasi

| Metode | Jalur | Keterangan |
| --- | --- | --- |
| POST | `/auth/challenge` | Terbitkan nonce + pesan untuk ditandatangani. Body: `{ walletAddress }` |
| POST | `/auth/verify` | Verifikasi signature ed25519 → token sesi. Body: `{ walletAddress, nonce, signature, displayName?, role?, countryCode?, email? }` |
| GET | `/auth/session` | Siapa pemilik token (`Authorization: Bearer`) |
| POST | `/auth/signout` | Cabut token |
| GET | `/auth/methods` | Metode login yang tersedia **dan jujur** status implementasinya |

Kode error: `INVALID_ADDRESS`, `CHALLENGE_NOT_FOUND`, `CHALLENGE_USED`, `CHALLENGE_EXPIRED`,
`ADDRESS_MISMATCH`, `BAD_SIGNATURE`, `PROFILE_REQUIRED` (wallet baru belum punya `displayName`;
nonce **tidak** terbakar sehingga tanda tangan yang sama bisa dikirim ulang).

## Header khusus demo

| Header | Arti | Aktif kapan |
| --- | --- | --- |
| `Authorization: Bearer <token>` | Identitas hasil SIWS | Selalu |
| `x-demo-backdate-hours` | Menggeser waktu event agar metrik demo realistis | Hanya bila `VIN_DEMO_MODE ≠ false` |
| `x-actor-id` | Identitas pemanggil tanpa tanda tangan | Hanya mode demo |

## Environment

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `8080` | Port API |
| `HOST` | `0.0.0.0` | Bind address |
| `VIN_DB_PATH` | `<repo>/.data/vin.db` | Lokasi basis data SQLite |
| `VIN_DEMO_MODE` | aktif | `false` mematikan endpoint demo, header `x-actor-id`, dan waktu simulasi |
| `VIN_AUTH_DOMAIN` | header `Host` | Domain di dalam pesan SIWS |
| `VIN_AUTH_URI` | `http(s)://<Host>` | URI di dalam pesan SIWS |
| `VIN_SOLANA_CHAIN_ID` | `solana:localnet` | Chain ID di dalam pesan SIWS |
| `VIN_API_URL` | `http://127.0.0.1:8080` | Dipakai Next.js untuk rewrite `/api/*` |
| `VIN_ESCROW_PROGRAM_ID` | — | Diisi setelah program Anchor di-deploy |
