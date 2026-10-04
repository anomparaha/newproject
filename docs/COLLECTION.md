# Menjalankan koleksi Postman sebagai regresi API

Koleksi `postman/collections/VIN API` diekspor sebagai berkas YAML (satu berkas
per request), jadi bisa dijalankan tanpa aplikasi Postman lewat
`tools/collection-runner.mjs`. Runner inilah yang dipakai job CI **API
regression (Postman flows)** di `.github/workflows/ci.yml`, dan bisa dipakai di
mesin lokal untuk hasil yang sama.

## Folder yang dijaga

| Folder | Isi |
| --- | --- |
| `E2E Happy Path` | listing → deal → escrow → inspeksi → handover → release |
| `E2E Dispute Path` | sengketa, arbitrase, refund |
| `Regression - Odometer Baseline` | kontrol anomali + pembuktian bahwa relist murah tidak bisa mereset baseline odometer |
| folder CRUD (Actors, Corridors, Deals, Listings, Meta, Reputation, `0. Setup`) | bentuk respons tiap endpoint: "tidak ada server error" + JSON + pemeriksaan bentuk saat 2xx |

CI menjalankan **semua** folder (`--all`), bukan hanya tiga folder flow: blok
assertion di folder CRUD-lah yang pernah menangkap cacat nyata (memutuskan
sengketa yang sudah selesai menjawab 500 karena refactor i18n menghilangkan
`return c.json(...)`). Assertion CRUD sengaja toleran terhadap ID basi — status
harus < 500, dan pemeriksaan bentuk hanya jalan bila respons 2xx — jadi cukup
`seed:reset` sebelum menjalankannya.

Runner menjalankan request menurut `order` di tiap folder, menjalankan script
`beforeRequest`/`afterResponse` apa adanya, dan melaporkan tiap assertion.
Keluar dengan kode 1 bila ada assertion yang gagal, jadi bisa dipakai langsung
sebagai gerbang CI.

## Di mesin lokal

```bash
npm ci                  # sekali saja; memasang juga paket `yaml` untuk runner
npm run build:shared
npm run seed:reset      # database demo baru di .data/vin.db
npm run dev:api         # terminal lain: API di http://localhost:8080
npm run collection:run  # ketiga folder regresi di atas
```

Varian:

```bash
npm run collection:run -- --list                # daftar folder yang tersedia
npm run collection:run -- --folder "Meta"       # satu folder saja
npm run collection:run -- --all                 # semua folder
VIN_BASE_URL=http://127.0.0.1:8099 npm run collection:run   # API di port lain
```

Runner hanya menerapkan potongan kecil API scripting Postman yang dipakai
koleksi ini (`pm.test`, `pm.expect`, `pm.response`, `pm.collectionVariables`).
Kalau sebuah script mulai memakai API lain, tambahkan ke shim — jangan lewati
request-nya, karena koleksi inilah suite regresinya.

## Membuktikan sebuah regresi memang "merah"

Supaya hasil hijau punya arti, folder regresi harus terbukti gagal pada kode
sebelum perbaikan. Caranya: jalankan kode lama di port terpisah dengan database
terpisah, lalu arahkan runner ke port itu.

```bash
git worktree add --detach /tmp/vprefix 3d1ff39   # contoh: kode sebelum fix odometer
cd /tmp/vprefix
npm ci -w @vin/api -w @vin/shared
npm run build:shared
VIN_DB_PATH=/tmp/vin-pre.db npx tsx services/api/src/seed.ts --reset
PORT=8099 VIN_DB_PATH=/tmp/vin-pre.db npx tsx services/api/src/index.ts
```

Lalu dari checkout utama:

```bash
VIN_BASE_URL=http://127.0.0.1:8099 npm run collection:run -- --folder "Regression - Odometer Baseline"
```

Hasil yang sudah pernah terbukti: pada `3d1ff39` folder itu memberi **21
assertion, 2 gagal** (langkah 10 dan 13 — relist di bawah rekor tidak
memunculkan peringatan, dan laporan 60.000 km lolos bersih setelah relist
50.000 km), sedangkan pada kode setelah perbaikan **21/21 lulus**. Total ketiga
folder pada kode yang benar: **36/36 request 2xx, 58/58 assertion**.

Di Windows PowerShell, ganti sintaks env-nya menjadi
`$env:VIN_DB_PATH="/tmp/vin-pre.db"; $env:PORT="8099"; npx tsx ...`.

## Catatan

- Data uji menumpuk di database yang dipakai. Untuk kondisi bersih, jalankan
  `npm run seed:reset` lagi sebelum demo.
- `.postman/resources.yaml` berisi ID workspace Postman lokal; berkas itu
  sengaja tidak di-commit perubahannya di mesin pengembang.
