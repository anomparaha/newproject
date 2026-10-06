# Batas hukum dan kepatuhan VIN

> **Ini bukan nasihat hukum.** Dokumen ini mencatat batas yang harus dipegang produk, beserta rujukan
> yang perlu diverifikasi ulang oleh penasihat hukum sebelum uang nyata bergerak. Regulasi berubah;
> status izin penyelenggara punya syarat yang tidak bisa disimpulkan dari artikel.
>
> **Catatan koridor (penting).** Analisis di §2 disusun untuk **entitas Indonesia** (OJK, Bank
> Indonesia, rupiah). Koridor pilot di kode sekarang **AE → KE** (`PILOT_CORRIDOR` di
> `services/api/src/policy.ts`), jadi izin lintas-negara, escrow berizin, dan KYB untuk koridor itu
> **belum** tercakup dokumen ini dan wajib ditinjau terpisah sebelum uang nyata bergerak.

## 1. Yang VIN klaim, dan yang tidak

| Diklaim | Tidak diklaim |
| --- | --- |
| Jejak klaim dan transaksi per nomor rangka | Kepemilikan hukum kendaraan |
| Escrow dana dengan syarat pelepasan tertulis | Pengganti BPKB, title, atau registrasi |
| Laporan inspeksi pada tanggal tertentu | Garansi kondisi sampai kendaraan tiba |
| Jaminan dan reputasi pelaku pasar | Jaminan hasil investasi |

NFT pada VIN adalah **nota dan jejak klaim**. Ia tidak memindahkan kepemilikan hukum. BPKB, title,
registrasi, bea cukai, pajak, dan balik nama tetap mengikuti hukum negara asal dan negara tujuan.

## 2. Kerangka Indonesia yang relevan

| Instrumen | Isi yang relevan bagi VIN | Rujukan |
| --- | --- | --- |
| UU No. 4 Tahun 2023 (P2SK) | Mengamanatkan peralihan pengaturan dan pengawasan aset kripto dari Bappebti ke OJK | [1](https://www.antaranews.com/berita/4547394/ojk-terbitkan-aturan-tentang-aset-kripto-jelang-transisi-dari-bappebti) |
| PP No. 49 Tahun 2024 | Peralihan tugas pengaturan dan pengawasan aset keuangan digital termasuk aset kripto | [2](https://www.pajak.go.id/en/node/117234) |
| POJK No. 27 Tahun 2024 jo. POJK No. 23 Tahun 2025 | Penyelenggaraan perdagangan aset keuangan digital termasuk aset kripto; kewajiban izin bagi penyelenggara | [3](https://pluang.com/akademi/berita-analisis/crypto-adalah-status-hukum-ojk) |
| PMK No. 50 Tahun 2025 | Pemajakan aset kripto | [4](https://www.pajak.go.id/en/node/117234) |
| Peran Bank Indonesia | Aspek yang menyentuh sistem pembayaran; kripto bukan alat pembayaran yang sah di Indonesia | [5](https://pluang.com/akademi/berita-analisis/crypto-adalah-status-hukum-ojk) |
| UU No. 27 Tahun 2022 (PDP) | Perlindungan data pribadi; dasar mengapa data pribadi tidak pernah on-chain | — |

Catatan penting dari rujukan di atas:

- Peralihan pengawasan dari Bappebti ke OJK mulai berlaku 10 Januari 2025 dan dinyatakan tuntas pada
  20 Januari 2026; sejak itu OJK memegang kendali penuh atas pengaturan, perizinan, dan pengawasan
  harian aset kripto, sementara Bank Indonesia berperan pada aspek sistem pembayaran.
- Aset kripto berstatus **aset keuangan digital**, bukan lagi komoditas, dan penyelenggara wajib
  memiliki izin.
- Kripto **bukan alat pembayaran yang sah** di Indonesia. Karena itu VIN tidak pernah memakai token
  volatil untuk membayar harga kendaraan, dan selalu menyalurkan fiat melalui penyedia berizin.

## 3. Konsekuensi desain produk (sudah dikodekan di repo ini)

1. **Uang kendaraan hanya stablecoin atau fiat.** Tidak ada jalur di kode yang membayar kendaraan
   dengan token platform. Lihat `FEES`, `BONDS`, dan `TOKEN_UTILITY` di `services/api/src/policy.ts`.
2. **Token hanya jaminan dan akses.** Tiga fungsi didefinisikan eksplisit, dan tiga hal yang
   dilarang juga didefinisikan eksplisit (bukan alat bayar harga mobil, bukan bagi hasil, bukan hak suara).
3. **Tanpa token tetap bisa memakai platform.** Fee bisa dibayar dengan stablecoin.
4. **Tidak ada data pribadi on-chain.** Yang on-chain hanya hash dan alamat (`anchorPayloadHash`).
5. **Negara yang tidak mengizinkan model ini tidak dilayani.** Daftar koridor dibatasi secara teknis:
   `POST /corridors` menolak pembukaan koridor baru sebelum koridor lama sehat.
6. **Tidak ada janji hasil.** Dokumen publik hanya memuat cara kerja pasar, batas hukum NFT, alur escrow,
   dan data koridor. Proyeksi harga token adalah hal yang dilarang dipublikasikan sebagai fakta
   (`PUBLICATION_STAGES`).

## 4. Wilayah abu-abu yang harus diselesaikan sebelum peluncuran

| Pertanyaan | Mengapa penting |
| --- | --- |
| Apakah jaminan token masuk kategori efek, komoditas, atau aset keuangan digital? | Menentukan siapa regulatornya dan izin apa yang dibutuhkan |
| Apakah platform memerlukan izin sebagai penyelenggara perdagangan aset keuangan digital? | POJK 27/2024 mewajibkan izin; menjalankan kegiatan tanpa izin berisiko pidana |
| Bagaimana perlakuan pajak jaminan yang terpotong dan dana sengketa? | Potongan bukan pendapatan platform bila masuk kas sengketa — perlu pembukuan yang membedakan |
| Bagaimana kewajiban AML/CFT untuk pembeli lintas negara? | KYC pembeli dasar vs KYB penjual/bengkel punya standar berbeda |
| Apakah escrow lintas negara memerlukan izin transfer dana? | Menentukan pilihan penyedia escrow per koridor |
| Bagaimana perlindungan konsumen bila bengkel memberi laporan menyesatkan? | Menentukan mekanisme kompensasi dan asuransi |

## 5. Yang tidak boleh dipublikasikan

Berdasarkan dokumen konsep VIN `§9`:

**Boleh:** cara kerja pasar, batas hukum NFT, alur escrow, data koridor percobaan, metrik publik
(deal selesai, waktu median sampai laporan, tingkat sengketa).

**Tidak boleh sebagai fakta:** proyeksi harga token, janji hasil untuk holder, klaim bahwa token
memberi hak atas pendapatan, dan klaim bahwa NFT memindahkan kepemilikan kendaraan.

## 6. Sebelum uang nyata bergerak

- [ ] Pendapat hukum tertulis untuk koridor pertama (kedua negara).
- [ ] Konfirmasi status perizinan yang diperlukan sesuai POJK yang berlaku.
- [ ] Pendaftaran/pelaporan pajak dan prosedur pembukuan untuk dana escrow dan kas sengketa.
- [ ] Kebijakan privasi + persetujuan pemrosesan data sesuai UU PDP.
- [ ] Perjanjian pengguna dengan klausul batas tanggung jawab dan penyelesaian sengketa.
- [ ] Prosedur KYB/KYC dan daftar sanksi (screening) untuk penjual, bengkel, dan pembeli.
- [ ] Rencana komunikasi bila terjadi kegagalan escrow atau penipuan.
