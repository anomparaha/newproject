# Sign-In With Solana (SIWS) — cara login yang sebenarnya

Dokumen ini menjelaskan autentikasi yang **sudah berjalan di kode**, bukan rencana.
Semua yang tertulis di sini bisa diperiksa di `services/api/src/auth.ts`,
`services/api/src/routes/auth.ts`, dan `services/api/tests/siws.test.ts`.

## 1. Prinsip

- **Wallet adalah identitas.** Alamat Solana (32 byte, base58) adalah public key ed25519.
  Kalau seseorang bisa menandatangani pesan dengan kunci itu, dia pemilik alamat tersebut.
- **Tidak ada password, tidak ada rahasia di server.** Server hanya menyimpan public key
  (alamat) dan hash token sesi.
- **Tidak ada "login sosial palsu".** Google/X belum tersambung ke OAuth, dan tidak akan
  pernah bisa memberi alamat wallet tanpa penyedia *embedded wallet*. Selama itu belum ada,
  tombolnya diberi label **UI only**.

## 2. Alur lengkap

```
1. GET  /api/auth/challenge            (POST, body: walletAddress)
   <- { nonce, message, expiresAt, knownWallet, chainId }

2. Wallet menandatangani `message` apa adanya (UTF-8, tanpa hash, tanpa prefix).
   Hasilnya: signature 64 byte, dikirim sebagai base58.

3. POST /api/auth/verify
   body: { walletAddress, nonce, signature, displayName?, role?, countryCode?, email? }
   -> 200/201 { token, expiresAt, created, actor }

4. Setiap penulisan data:
   Authorization: Bearer <token>

5. GET  /api/auth/session   -> siapa saya (dipakai frontend untuk membuang token basi)
6. POST /api/auth/signout   -> mencabut token
7. GET  /api/auth/methods   -> daftar metode + kejujuran status implementasinya
```

Isi pesan yang ditandatangani (urutan field mengikuti konvensi SIWS/SIWE):

```
<domain> wants you to sign in with your Solana account:
<alamat>

Sign in to VIN. This signature proves you control this wallet. It does not move funds,
approve a transaction, or cost anything.

URI: <uri>
Version: 1
Chain ID: <chainId>
Nonce: <nonce>
Issued At: <waktu terbit>
Expiration Time: <waktu kedaluwarsa>
```

## 3. Sifat keamanan yang diuji

| Sifat | Diuji di |
|---|---|
| Signature valid membuat sesi | `siws.test.ts` — keypair ed25519 asli |
| Pesan yang diubah → ditolak | `siws.test.ts` (`BAD_SIGNATURE`) |
| Ditandatangani kunci lain → ditolak | `siws.test.ts` |
| Signature diubah satu byte → ditolak | `siws.test.ts` |
| Nonce **sekali pakai** (replay → 409) | `siws.test.ts`, bukti hidup: `CHALLENGE_USED` |
| Nonce kedaluwarsa → 409 | `siws.test.ts` |
| Token memberi akses tulis berbasis identitas | `siws.test.ts` + bukti hidup (201) |
| Sign-out mencabut token (langsung 403) | `siws.test.ts` |
| `VIN_DEMO_MODE=false` → header `x-actor-id` mati total | `siws.test.ts` + bukti hidup (403) |
| Codec base58 cocok dengan standar | vektor eksternal di `siws.test.ts` |

**Bukti bahwa nonce tidak terbakar saat profil belum lengkap**: `POST /api/auth/verify`
tanpa `displayName` untuk wallet baru menjawab `400 PROFILE_REQUIRED`, dan **signature yang
sama** masih bisa dipakai setelah `displayName` dikirim. Artinya pengguna hanya melihat
**satu** permintaan tanda tangan, bukan dua.

## 4. Mode demo vs mode sesi

| | `VIN_DEMO_MODE=true` (default) | `VIN_DEMO_MODE=false` |
|---|---|---|
| Token sesi | berlaku | berlaku |
| Header `x-actor-id` | **berlaku** (untuk seed, smoke, koleksi Postman) | **ditolak** (403) |
| Endpoint `/api/demo/actors` | 200 | 404 |
| Jam simulasi `x-demo-backdate-hours` | berlaku | diabaikan |

**Produksi wajib `VIN_DEMO_MODE=false`.** Dengan mode demo menyala, siapa pun bisa
menyamar sebagai aktor mana pun hanya dengan satu header — itu memang alat demo, bukan
keamanan.

Aturan resolusi identitas (`services/api/src/context.ts`):

1. Kalau ada `Authorization: Bearer`, **itu** identitasnya.
2. Token ada tetapi tidak valid/kedaluwarsa/dicabut → **gagal tertutup** (tidak jatuh
   kembali ke header demo).
3. Tanpa token, baru header `x-actor-id` dilihat (dan hanya kalau mode demo menyala).

## 5. Yang BELUM ada (jangan diklaim ada)

- **Rate limiting** pada `/api/auth/challenge` dan `/api/auth/verify`. Belum ada.
- **Token di localStorage** di frontend. Untuk demo cukup; produksi sebaiknya cookie
  httpOnly + CSRF.
- **Bind perangkat / sidik jari sesi.** Belum ada.
- **Penyimpanan bukti (foto/berkas)**. Belum ada; karena itu halaman listing menampilkan
  gambar placeholder dengan label.
- **KYB otomatis.** Akun penjual/bengkel/curator dibuat dengan `verification='none'` dan
  menunggu verifikasi manual curator (di produksi: attestation).
- **Kredensial OAuth Google/X** dan **embedded wallet**: milik pengguna; tanpa itu,
  tombol sosial tetap `UI only`.
- **Audit keamanan.** Belum ada.
- Sebagian route `deals` masih menerima `actorId`/`buyerId` dari **body** (warisan desain
  awal). Pekerjaan berikutnya: ubah semuanya memakai `resolveActorId` seperti route lain.

## 6. Uji sendiri dengan curl

```bash
API=http://localhost:8080

# 1. buat keypair uji + alamat
node -e "
const {generateKeyPairSync}=require('node:crypto');
const {publicKey}=generateKeyPairSync('ed25519');
const raw=publicKey.export({format:'der',type:'spki'}).subarray(12);
const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let out='',n=BigInt('0x'+raw.toString('hex'));
while(n>0n){out=A[Number(n%58n)]+out;n/=58n;}
for(const b of raw){if(b===0)out='1'+out;else break;}
console.log(out);
"

# 2. minta challenge
curl -s -X POST $API/api/auth/challenge -H 'content-type: application/json' \
  -d '{"walletAddress":"<ALAMAT>"}' | tee /tmp/ch.json

# 3. tanda tangani pesannya (script kecil, seperti di docs/SIWS.md langkah 2), lalu:
curl -s -X POST $API/api/auth/verify -H 'content-type: application/json' \
  -d '{"walletAddress":"<ALAMAT>","nonce":"<NONCE>","signature":"<SIG>","displayName":"Test Buyer"}'

# 4. pakai token
curl -s $API/api/auth/session -H "Authorization: Bearer <TOKEN>"
```

Di browser: buka aplikasi → **Sign in** → **Connect wallet**. Kalau ekstensi
Phantom/Solflare/Backpack terpasang, wallet akan meminta tanda tangan satu kali.
Kalau tidak ada ekstensi, gunakan **demo binding** (dan UI akan mengatakannya).

## 7. Konfigurasi

| Variabel | Arti | Default |
|---|---|---|
| `VIN_DEMO_MODE` | `false` mematikan header `x-actor-id` sepenuhnya | `true` |
| `VIN_AUTH_DOMAIN` | Domain di pesan SIWS | header `Host` |
| `VIN_AUTH_URI` | URI di pesan SIWS | `http(s)://<Host>` |
| `VIN_SOLANA_CHAIN_ID` | Chain ID di pesan | `solana:localnet` (program belum di-deploy) |

Jangan set `VIN_AUTH_DOMAIN` ke nilai palsu: pesan yang ditandatangani pengguna harus
menyebut domain asli, kalau tidak login phising akan lolos.
