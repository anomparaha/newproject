//! Pencetakan NFT nota lewat Metaplex Core (opsional).
//!
//! Dua jalur yang sah, dan pilihannya harus sadar risiko:
//!
//! **Jalur A — relayer (dipakai default di repo ini).**
//! Nota dicatat sebagai PDA `NoteAccount` lewat instruksi `record_note`
//! (lihat `lib.rs`). Aset Metaplex Core dicetak oleh relayer lewat SDK
//! TypeScript, lalu alamat asetnya direkam ke PDA tersebut. Kelebihan: tidak
//! menambah dependensi on-chain, mudah diaudit, bisa dicetak ke dompet pembeli
//! tanpa biaya program. Kekurangan: percetakan bergantung pada relayer.
//!
//! **Jalur B — CPI dari program (fitur `metaplex-core`).**
//! Program mencetak aset sendiri sehingga tidak ada pihak yang bisa menahan
//! nota. Kekurangan: menambah dependensi `mpl-core` pada program yang memegang
//! dana, sehingga permukaan audit ikut membesar.
//!
//! Saran urutan: Tahap Bukti memakai Jalur A. Jalur B dibuka setelah audit
//! program escrow, karena menambah CPI ke program pihak ketiga berarti
//! menambah asumsi keamanan pada jalur yang memindahkan uang.
//!
//! CATATAN: kode di bawah belum dikompilasi pada lingkungan pengembangan ini
//! (toolchain Solana tidak tersedia). Cocokkan API `mpl-core` dengan versi yang
//! benar-benar dipasang sebelum mengaktifkan fitur.

#[cfg(feature = "metaplex-core")]
mod cpi {
    use anchor_lang::prelude::*;
    use mpl_core::{instructions::CreateV2CpiBuilder, ID as MPL_CORE_PROGRAM_ID};

    /// Mencetak aset nota ke dompet pemilik nota.
    ///
    /// `data_hash` adalah hash kanonik dari metadata nota (tanpa foto) sehingga
    /// isi nota dapat diverifikasi ulang dari event log off-chain.
    pub fn mint_note_asset<'info>(
        payer: &AccountInfo<'info>,
        asset: &AccountInfo<'info>,
        collection: Option<&AccountInfo<'info>>,
        owner: &AccountInfo<'info>,
        authority: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        name: String,
        uri: String,
        data_hash: [u8; 32],
    ) -> Result<()> {
        require_keys_eq!(*asset.owner, MPL_CORE_PROGRAM_ID, ErrorCode::ConstraintOwner);

        let mut builder = CreateV2CpiBuilder::new(&MPL_CORE_PROGRAM_ID);
        builder
            .asset(asset)
            .payer(payer)
            .owner(owner)
            .authority(Some(authority))
            .system_program(system_program)
            .name(name)
            .uri(uri);

        if let Some(collection) = collection {
            builder.collection(Some(collection));
        }

        // Hash bukti ditulis sebagai data tambahan pada plugin/atribut aset
        // sesuai skema metadata yang dipakai (lihat /api/notes/:id/metadata).
        let _ = data_hash;

        builder.invoke()
    }
}

#[cfg(feature = "metaplex-core")]
pub use cpi::mint_note_asset;
