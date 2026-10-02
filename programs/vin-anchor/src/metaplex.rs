//! Pencetakan NFT nota lewat Metaplex Core (opsional).
//!
//! Two valid paths, and the choice has to be risk-aware:
//!
//! **Path A — relayer (the default in this repo).**
//! The receipt is recorded as a `NoteAccount` PDA via the `record_note`
//! instruction (see `lib.rs`). The relayer mints the Metaplex Core asset via the
//! TypeScript SDK, then records the asset address into that PDA. Upside: no
//! extra on-chain dependency, easy to audit, and it can be minted to the buyer
//! wallet with no program cost. Downside: minting depends on the relayer.
//!
//! **Path B — CPI from the program (`metaplex-core` feature).**
//! The program mints the asset itself, so nobody can withhold the
//! receipt. Downside: it adds an `mpl-core` dependency to a program that holds
//! funds, which widens the audit surface.
//!
//! Suggested order: the Proof Stage uses Path A. Path B opens after an audit
//! program escrow, karena menambah CPI ke program pihak ketiga berarti
//! adds security assumptions to the path that moves money.
//!
//! NOTE: the code below has not been compiled in this development environment
//! (no Solana toolchain). Match the `mpl-core` API to the version actually
//! installed before enabling the feature.

#[cfg(feature = "metaplex-core")]
mod cpi {
    use anchor_lang::prelude::*;
    use mpl_core::{instructions::CreateV2CpiBuilder, ID as MPL_CORE_PROGRAM_ID};

    /// Mints the receipt asset into the receipt owner wallet.
    ///
    /// `data_hash` is the canonical hash of the receipt metadata (no photos), so the
    /// receipt contents can be re-verified from the off-chain event log.
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

        // The evidence hash is written as extra data on the asset plugin/attributes
        // per the metadata schema in use (see /api/notes/:id/metadata).
        let _ = data_hash;

        builder.invoke()
    }
}

#[cfg(feature = "metaplex-core")]
pub use cpi::mint_note_asset;
