# Menjalankan build + test Anchor di mesin lokal

> Untuk koleksi Postman (regresi API lewat `npm run collection:run`), lihat
> `docs/COLLECTION.md`.

Panduan singkat untuk menjalankan hal yang sama dengan pipeline
`.github/workflows/anchor.yml` (build program SBF, build IDL, lalu seluruh
test suite terhadap validator lokal) di komputer sendiri.

> Sandbox pengembangan yang dipakai agen **tidak punya** Rust, Solana CLI, atau
> Anchor CLI (hanya Node, Python, dan akses GitHub), jadi kompilasi dan
> eksekusi validator hanya bisa terjadi di GitHub Actions **atau** di mesin
> Anda. Perintah di bawah ini adalah jalur lokalnya.

## 1. Prasyarat (sekali saja)

| Kebutuhan | Versi yang dipakai proyek |
| --- | --- |
| Rust | `stable` (rustup) |
| Solana CLI (Agave) | `stable` |
| Anchor CLI | `0.30.1` (lihat `Anchor.toml`: `anchor_version = "0.30.1"`) |
| Node.js + npm | Node 22 (`programs/vin-anchor` punya `package-lock.json`, pakai `npm ci`) |
| Wallet provider | file JSON di path `wallet` pada `Anchor.toml` (`~/.config/solana/id.json`) |

```bash
# Solana CLI
curl -sSfL https://release.anza.xyz/stable/install | sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version

# Anchor CLI 0.30.1
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.30.1 && avm use 0.30.1
anchor --version          # harus mencetak 0.30.1

# Wallet untuk provider lokal (lewati kalau sudah ada)
solana-keygen new --no-bip39-passphrase --force -o "$HOME/.config/solana/id.json"
```

## 2. Ambil kode dan dependensi test

```bash
cd /path/ke/newproject
git fetch origin && git checkout arena/01a0fdf4-newproject && git pull
git log --oneline -1        # catat commit-nya: hasil test harus dilaporkan bersama commit ini
(cd programs/vin-anchor && npm ci)
```

## 3. Build (dua langkah, sama seperti CI)

`anchor build` biasa menjalankan langkah IDL dengan
`RUSTFLAGS=--cfg procmacro2_semver_exempt`, dan pada Rust modern langkah itu
gagal di dalam `proc-macro2`. Karena itu build dipecah: kompilasi SBF dulu,
lalu IDL dengan flag itu dimatikan.

```bash
anchor build --no-idl

CARGO_ENCODED_RUSTFLAGS="" anchor idl build \
  --program-name vin-anchor \
  --out target/idl/vin_anchor.json \
  --out-ts target/types/vin_anchor.ts
```

Hasilnya: `target/deploy/vin_anchor.so`, `target/idl/vin_anchor.json`,
`target/types/vin_anchor.ts`.

## 4. Test

```bash
anchor test --skip-build
```

`--skip-build` memakai hasil langkah 3 dan menyalakan `solana-test-validator`
sendiri (program dimuat dari `target/deploy/vin_anchor.so`; `startup_wait`
sudah dinaikkan ke 60 detik di `Anchor.toml`).

Hanya satu skenario:

```bash
# terminal 1: validator yang memuat program
anchor localnet
# terminal 2: satu test, mis. skenario 1 dan 2
programs/vin-anchor/node_modules/.bin/ts-mocha \
  -p programs/vin-anchor/tsconfig.json -t 1000000 \
  'programs/vin-anchor/tests/**/*.ts' --grep "^(1|2)\."
```

## 5. Yang perlu dikirim balik ke agen

Seluruh keluaran `anchor test --skip-build` (atau bagian ini saja):

1. baris ringkasan `X passing` / `Y failing`;
2. kalau ada yang gagal: blok pesan errornya, termasuk baris `Left:` /
   `Right:` pada kegagalan `ConstraintSeeds` dan log program yang menyertai
   instruksi yang gagal.

## 6. Kalau ada masalah

| Gejala | Sebab / tindakan |
| --- | --- |
| `proc macro panicked` / error `proc-macro2` di langkah IDL | Pakai urutan dua langkah di §3. |
| Validator gagal start, `Blockhash not found` | Runner/mesin lambat: ulangi, atau naikkan `[test] startup_wait` di `Anchor.toml`. |
| `Cannot find module '../../../target/idl/vin_anchor.json'` | Langkah IDL (§3) belum jalan atau menulis ke path lain. |
| `provider wallet` tidak ditemukan | `solana-keygen new -o ~/.config/solana/id.json` (§1). |
| Hasil test aneh / tidak bisa dipercaya | Periksa dulu apakah ada fungsi yang melewati budget frame SBF: `grep -c "overflows the maximum allowed frame space" <log build>`. Kalau ada, build tetap sukses tapi perilaku runtime-nya *undefined*; perbaiki dulu sebelum mengejar bug lain. CI menolak menjalankan test bila menemukannya. |

---

## 7. Mencoba login SIWS di mesin lokal

Semua perintah di bawah dijalankan dari root repo. Ini **tidak butuh** Solana CLI
maupun validator: signature dibuat oleh keypair sementara di Node.

```bash
# 1. API dengan mode demo MATI (jadi hanya token yang berlaku)
npm run seed:reset
VIN_DEMO_MODE=false npm run dev:api        # terminal 1

# 2. web
npm run dev:web                            # terminal 2
```

Uji otomatis (paling cepat, sudah termasuk semua kasus negatif):

```bash
npx tsx --test services/api/tests/siws.test.ts     # 10/10 harus hijau
```

Uji lewat HTTP dengan keypair asli dan signature asli (skrip sekali pakai):

```bash
cat > siws-check.local.ts <<'TS'
import { generateKeyPairSync, sign } from 'node:crypto';
import { base58Encode } from './services/api/src/base58.ts';

async function main() {
  const base = 'http://127.0.0.1:8080';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const address = base58Encode(new Uint8Array(raw));

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const ch = await (await post('/api/auth/challenge', { walletAddress: address })).json() as any;
  const signature = base58Encode(new Uint8Array(sign(null, Buffer.from(ch.message, 'utf8'), privateKey)));

  const noProfile = await post('/api/auth/verify', { walletAddress: address, nonce: ch.nonce, signature });
  console.log('tanpa profil   ->', noProfile.status, (await noProfile.json() as any).error?.code);

  const ok = await post('/api/auth/verify', { walletAddress: address, nonce: ch.nonce, signature, displayName: 'Uji Lokal' });
  const body = await ok.json() as any;
  console.log('dengan profil  ->', ok.status, 'created =', body.created);

  const ses = await fetch(base + '/api/auth/session', { headers: { authorization: `Bearer ${body.token}` } });
  console.log('sesi           ->', ses.status, (await ses.json() as any).actor?.displayName);

  const replay = await post('/api/auth/verify', { walletAddress: address, nonce: ch.nonce, signature });
  console.log('replay         ->', replay.status, (await replay.json() as any).error?.code);

  const headerOnly = await post(`/api/actors/${body.actor.id}/affiliations`, { relatedActorId: body.actor.id }, { 'x-actor-id': body.actor.id });
  console.log('header saja    ->', headerOnly.status, '(harus 403 karena demo mati)');
}
void main();
TS
npx tsx siws-check.local.ts && rm siws-check.local.ts
```

Yang diharapkan: `400 PROFILE_REQUIRED` → `201` → `200` → `409 CHALLENGE_USED` → `403`.

Di browser: buka aplikasi → **Sign in** → **Connect wallet**. Kalau ekstensi
Phantom/Solflare/Backpack ada, akan muncul satu permintaan tanda tangan. Kalau tidak ada,
pakai **demo binding** (aplikasi akan mengatakan bahwa itu tanpa tanda tangan).
