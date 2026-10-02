//! # VIN — escrow, jaminan, dan registri nota (Solana / Anchor)
//!
//! Prinsip yang dikodekan di sini:
//!
//! 1. **Dua vault terpisah.** Dana kendaraan dan dana inspeksi berada di dua
//!    token account berbeda. Satu leg tidak pernah bisa menyentuh leg lain.
//! 2. **Pelepasan butuh bukti.** Setiap pelepasan dana menerima `evidence_hash`
//!    yang dicatat on-chain. Tanpa bukti, dana tidak cair (dijaga di off-chain
//!    event log dan divalidasi ulang di sini).
//! 3. **Sengketa membekukan.** `release_leg` dan `refund_leg` ditolak selagi
//!    `deal.frozen`; hanya arbiter yang bisa menyelesaikan.
//! 4. **Potongan jaminan masuk kas sengketa**, tidak pernah ke dompet tim.
//! 5. **Yang on-chain hanya hash.** VIN penuh, foto, BPKB, dan data pribadi
//!    tetap off-chain. NFT nota adalah jejak klaim, bukan surat kendaraan.
//!
//! STATUS: ditulis sebagai jalur produksi, **belum dikompilasi atau di-deploy**
//! pada lingkungan pengembangan ini (toolchain Rust/Solana tidak tersedia di
//! sandbox). Jalankan `anchor build && anchor test` lalu ganti `declare_id!`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// Leg dana. Kendaraan dan inspeksi TIDAK PERNAH dicampur.
pub const LEG_VEHICLE: u8 = 0;
pub const LEG_INSPECTION: u8 = 1;

/// Peran aktor. Sama dengan `ROLES` di paket @vin/shared.
pub const ROLE_BUYER: u8 = 0;
pub const ROLE_SELLER: u8 = 1;
pub const ROLE_INSPECTOR: u8 = 2;
pub const ROLE_CURATOR: u8 = 3;
pub const ROLE_ARBITER: u8 = 4;

/// Putusan arbitrase.
pub const DECISION_REFUND_BUYER: u8 = 0;
pub const DECISION_RELEASE_SELLER: u8 = 1;
pub const DECISION_SPLIT: u8 = 2;
pub const DECISION_BOND_SLASHED: u8 = 3;

#[program]
pub mod vin_anchor {
    use super::*;

    /// Konfigurasi awal. `admin` sebaiknya multisig (mis. Squads) sejak mainnet.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        arbiter: Pubkey,
        relayer: Pubkey,
        fee_treasury: Pubkey,
        fee_bps_vehicle: u16,
        fee_bps_inspection: u16,
    ) -> Result<()> {
        require!(fee_bps_vehicle <= MAX_FEE_BPS, VinError::FeeTooHigh);
        require!(fee_bps_inspection <= MAX_FEE_BPS, VinError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.arbiter = arbiter;
        config.relayer = relayer;
        // Fee hanya bisa masuk ke alamat treasury yang dikunci di config.
        // Relayer tidak boleh mengarahkan fee ke dompetnya sendiri.
        config.fee_treasury = fee_treasury;
        config.dispute_fund = ctx.accounts.dispute_fund.key();
        config.fee_bps_vehicle = fee_bps_vehicle;
        config.fee_bps_inspection = fee_bps_inspection;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin (multisig) dapat mengganti relayer, arbiter, treasury fee, dan
    /// menjeda program. Tidak ada instruksi yang bisa memindahkan dana ke admin.
    pub fn set_authorities(
        ctx: Context<AdminOnly>,
        relayer: Option<Pubkey>,
        arbiter: Option<Pubkey>,
        fee_treasury: Option<Pubkey>,
        paused: Option<bool>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(relayer) = relayer {
            config.relayer = relayer;
        }
        if let Some(arbiter) = arbiter {
            config.arbiter = arbiter;
        }
        if let Some(fee_treasury) = fee_treasury {
            config.fee_treasury = fee_treasury;
        }
        if let Some(paused) = paused {
            config.paused = paused;
        }
        Ok(())
    }

    /// Aktor terdaftar dengan hash attestation identitas.
    /// Data identitas usaha tetap off-chain dan dapat dicabut.
    pub fn register_actor(ctx: Context<RegisterActor>, role: u8, attestation: [u8; 32]) -> Result<()> {
        require!(role <= ROLE_ARBITER, VinError::InvalidRole);
        let actor = &mut ctx.accounts.actor;
        actor.wallet = ctx.accounts.wallet.key();
        actor.role = role;
        actor.attestation = attestation;
        actor.revoked = false;
        actor.bond_locked = 0;
        actor.bump = ctx.bumps.actor;
        Ok(())
    }

    /// Identitas bisa dicabut. Aktor yang dicabut tidak boleh membuka deal baru.
    pub fn revoke_actor(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.actor.revoked = true;
        Ok(())
    }

    /// Jaminan dikunci dalam stablecoin. Jaminan hanya untuk kelayakan dan
    /// kapasitas operasional — token tidak membeli harga kendaraan.
    pub fn lock_bond(ctx: Context<LockBond>, amount: u64, purpose: u8) -> Result<()> {
        require!(amount > 0, VinError::ZeroAmount);
        require!(!ctx.accounts.actor.revoked, VinError::ActorRevoked);
        require!(!ctx.accounts.config.paused, VinError::Paused);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bonder_token.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                    authority: ctx.accounts.bonder.to_account_info(),
                },
            ),
            amount,
        )?;
        let actor = &mut ctx.accounts.actor;
        actor.bond_locked = actor.bond_locked.checked_add(amount).ok_or(VinError::MathOverflow)?;
        emit!(BondLocked {
            actor: actor.key(),
            amount,
            purpose,
        });
        Ok(())
    }

    /// Jaminan dikembalikan setelah deal bersih (dipicu relayer atas dasar event
    /// log off-chain yang terbuka untuk diaudit).
    pub fn return_bond(ctx: Context<SettleBond>, amount: u64, reason_hash: [u8; 32]) -> Result<()> {
        require!(amount > 0, VinError::ZeroAmount);
        let actor = &mut ctx.accounts.actor;
        require!(actor.bond_locked >= amount, VinError::InsufficientBond);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.actor_token.to_account_info(),
                    authority: ctx.accounts.actor.to_account_info(),
                },
                &[&[b"actor", actor.wallet.as_ref(), &[actor.bump]]],
            ),
            amount,
        )?;
        actor.bond_locked = actor.bond_locked.checked_sub(amount).ok_or(VinError::MathOverflow)?;
        emit!(BondReturned { actor: actor.key(), amount, reason_hash });
        Ok(())
    }

    /// Membuka deal: dua vault dibuat terpisah dalam satu transaksi.
    pub fn open_deal(
        ctx: Context<OpenDeal>,
        vin_hash: [u8; 32],
        vehicle_amount: u64,
        inspection_amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, VinError::Paused);
        require!(vehicle_amount > 0 && inspection_amount > 0, VinError::ZeroAmount);
        require!(!ctx.accounts.buyer_actor.revoked, VinError::ActorRevoked);
        require!(!ctx.accounts.seller_actor.revoked, VinError::ActorRevoked);
        require!(!ctx.accounts.inspector_actor.revoked, VinError::ActorRevoked);
        // Bengkel wajib mengunci jaminan sebelum menerima order.
        require!(ctx.accounts.inspector_actor.bond_locked > 0, VinError::BondRequired);

        let deal = &mut ctx.accounts.deal;
        deal.vin_hash = vin_hash;
        deal.buyer = ctx.accounts.buyer.key();
        deal.seller = ctx.accounts.seller.key();
        deal.inspector = ctx.accounts.inspector.key();
        deal.vehicle_amount = vehicle_amount;
        deal.inspection_amount = inspection_amount;
        deal.vehicle_released_amount = 0;
        deal.inspection_released_amount = 0;
        deal.frozen = false;
        deal.cancelled = false;
        deal.completed = false;
        deal.evidence_root = [0u8; 32];
        deal.bump = ctx.bumps.deal;

        emit!(DealOpened {
            deal: deal.key(),
            vin_hash,
            buyer: deal.buyer,
            seller: deal.seller,
            inspector: deal.inspector,
            vehicle_amount,
            inspection_amount,
        });
        Ok(())
    }

    /// Pembeli mendanai satu leg. Dua kali panggil (kendaraan, inspeksi).
    pub fn fund_leg(ctx: Context<FundLeg>, leg: u8, amount: u64) -> Result<()> {
        require!(!ctx.accounts.deal.frozen, VinError::DealFrozen);
        require!(amount > 0, VinError::ZeroAmount);

        // Vault dibatasi: dana masuk tidak boleh melebihi jumlah yang dikunci
        // saat deal dibuka, sehingga saldo vault selalu bisa diaudit.
        let (vault, current, expected) = match leg {
            LEG_VEHICLE => (
                ctx.accounts.vehicle_vault.to_account_info(),
                ctx.accounts.vehicle_vault.amount,
                ctx.accounts.deal.vehicle_amount,
            ),
            LEG_INSPECTION => (
                ctx.accounts.inspection_vault.to_account_info(),
                ctx.accounts.inspection_vault.amount,
                ctx.accounts.deal.inspection_amount,
            ),
            _ => return err!(VinError::InvalidLeg),
        };
        require!(
            current.checked_add(amount).ok_or(VinError::MathOverflow)? <= expected,
            VinError::OverFunded
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    to: vault,
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(LegFunded {
            deal: ctx.accounts.deal.key(),
            leg,
            amount,
        });
        Ok(())
    }

    /// Sengketa membekukan deal. Boleh dipicu pembeli, penjual, atau bengkel.
    pub fn freeze_deal(ctx: Context<FreezeDeal>, reason_hash: [u8; 32]) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let deal = &ctx.accounts.deal;
        require!(
            caller == deal.buyer || caller == deal.seller || caller == deal.inspector,
            VinError::Unauthorized
        );
        ctx.accounts.deal.frozen = true;
        emit!(DealFrozenEvent {
            deal: deal.key(),
            reason_hash,
        });
        Ok(())
    }

    /// Pelepasan dana satu leg. Hanya relayer (hot key platform) yang boleh,
    /// dengan `evidence_hash` sebagai bukti yang dapat diaudit.
    /// Dana kendaraan HANYA boleh lepas setelah syarat serah terima terpenuhi
    /// di off-chain event log; tx ini menuntut hash bukti yang cocok.
    pub fn release_leg(
        ctx: Context<ReleaseLeg>,
        leg: u8,
        amount: u64,
        evidence_hash: [u8; 32],
        platform_fee_amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VinError::ZeroAmount);
        require!(ctx.accounts.relayer.key() == ctx.accounts.config.relayer, VinError::Unauthorized);
        // Deal yang dibekukan atau sudah ditutup tidak boleh dilepas.
        require!(!ctx.accounts.deal.frozen, VinError::DealFrozen);
        require!(!ctx.accounts.deal.cancelled, VinError::DealCancelled);
        require!(!ctx.accounts.deal.completed, VinError::DealCompleted);

        let deal = &mut ctx.accounts.deal;
        let (vault, destination, released_field, total) = match leg {
            LEG_VEHICLE => (
                ctx.accounts.vehicle_vault.to_account_info(),
                ctx.accounts.seller_token.to_account_info(),
                ReleasedField::Vehicle,
                deal.vehicle_amount,
            ),
            LEG_INSPECTION => (
                ctx.accounts.inspection_vault.to_account_info(),
                ctx.accounts.inspector_token.to_account_info(),
                ReleasedField::Inspection,
                deal.inspection_amount,
            ),
            _ => return err!(VinError::InvalidLeg),
        };

        let already = match released_field {
            ReleasedField::Vehicle => deal.vehicle_released_amount,
            ReleasedField::Inspection => deal.inspection_released_amount,
        };
        require!(
            already.checked_add(amount).ok_or(VinError::MathOverflow)? <= total,
            VinError::OverRelease
        );
        // Fee tidak boleh melebihi batas bps yang dikonfigurasi, dan tujuannya
        // dikunci oleh constraint akun ke config.fee_treasury.
        let bps = match leg {
            LEG_VEHICLE => ctx.accounts.config.fee_bps_vehicle,
            _ => ctx.accounts.config.fee_bps_inspection,
        };
        let max_fee = amount
            .checked_mul(bps as u64)
            .ok_or(VinError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(VinError::MathOverflow)?;
        require!(platform_fee_amount <= max_fee, VinError::FeeTooHigh);

        // Semua nilai yang dipakai untuk menandatangani diambil sebagai salinan
        // lebih dulu supaya tidak ada pinjaman ganda ke akun deal.
        let vin_hash = deal.vin_hash;
        let buyer_key = deal.buyer;
        let deal_bump = deal.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"deal", vin_hash.as_ref(), buyer_key.as_ref(), &[deal_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: vault.clone(),
                    to: destination,
                    authority: deal.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        if platform_fee_amount > 0 {
            // Fee platform diambil dari leg yang sama, ke alamat penerima fee.
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: vault,
                        to: ctx.accounts.fee_destination.to_account_info(),
                        authority: deal.to_account_info(),
                    },
                    signer_seeds,
                ),
                platform_fee_amount,
            )?;
        }

        match released_field {
            ReleasedField::Vehicle => {
                deal.vehicle_released_amount = already.checked_add(amount).ok_or(VinError::MathOverflow)?;
            }
            ReleasedField::Inspection => {
                deal.inspection_released_amount = already.checked_add(amount).ok_or(VinError::MathOverflow)?;
            }
        }

        emit!(LegReleased {
            deal: deal.key(),
            leg,
            amount,
            platform_fee_amount,
            evidence_hash,
        });
        Ok(())
    }

    /// Pengembalian dana ke pembeli (pembatalan sebelum serah terima).
    ///
    /// PENTING: deal yang DIBEKUKAN tidak boleh di-refund lewat instruksi ini.
    /// Tanpa penjagaan ini, relayer bisa melewati arbitrase dengan mengembalikan
    /// dana sebelum arbiter memutuskan — pembekuan sengketa jadi tidak ada artinya.
    /// Pengembalian pasca-sengketa hanya lewat `resolve_dispute`.
    pub fn refund_leg(ctx: Context<RefundLeg>, leg: u8, evidence_hash: [u8; 32]) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        require!(ctx.accounts.relayer.key() == ctx.accounts.config.relayer, VinError::Unauthorized);
        require!(!deal.frozen, VinError::DealFrozen);
        require!(!deal.completed, VinError::DealCompleted);
        require!(!deal.cancelled, VinError::DealCancelled);

        let (vault, amount) = match leg {
            LEG_VEHICLE => (
                ctx.accounts.vehicle_vault.to_account_info(),
                deal.vehicle_amount.checked_sub(deal.vehicle_released_amount).ok_or(VinError::MathOverflow)?,
            ),
            LEG_INSPECTION => (
                ctx.accounts.inspection_vault.to_account_info(),
                deal.inspection_amount.checked_sub(deal.inspection_released_amount).ok_or(VinError::MathOverflow)?,
            ),
            _ => return err!(VinError::InvalidLeg),
        };
        require!(amount > 0, VinError::ZeroAmount);

        let vin_hash = deal.vin_hash;
        let buyer_key = deal.buyer;
        let deal_bump = deal.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"deal", vin_hash.as_ref(), buyer_key.as_ref(), &[deal_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: vault,
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: deal.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
        match leg {
            LEG_VEHICLE => deal.vehicle_released_amount = deal.vehicle_amount,
            _ => deal.inspection_released_amount = deal.inspection_amount,
        }
        emit!(LegRefunded {
            deal: deal.key(),
            leg,
            amount,
            evidence_hash,
        });
        Ok(())
    }

    /// Putusan arbitrase untuk deal yang dibekukan.
    ///
    /// Akuntansi WAJIB tepat habis, supaya tidak ada dana tersangkut di vault:
    ///   - leg kendaraan: `to_buyer + to_seller == sisa leg kendaraan`
    ///   - leg inspeksi:  `to_inspector <= sisa leg inspeksi`, sisanya kembali ke pembeli
    ///
    /// Jadi bengkel yang sudah mengerjakan inspeksi tetap bisa dibayar walau deal
    /// dibatalkan, dan tidak ada saldo yang menganggur tanpa pemilik.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        decision: u8,
        to_buyer: u64,
        to_seller: u64,
        to_inspector: u64,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        require!(ctx.accounts.arbiter.key() == ctx.accounts.config.arbiter, VinError::Unauthorized);
        require!(decision <= DECISION_BOND_SLASHED, VinError::InvalidDecision);

        let deal = &mut ctx.accounts.deal;
        require!(deal.frozen, VinError::DealNotFrozen);

        let vin_hash = deal.vin_hash;
        let buyer_key = deal.buyer;
        let deal_bump = deal.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"deal", vin_hash.as_ref(), buyer_key.as_ref(), &[deal_bump]]];

        let vehicle_remaining = deal
            .vehicle_amount
            .checked_sub(deal.vehicle_released_amount)
            .ok_or(VinError::MathOverflow)?;
        let inspection_remaining = deal
            .inspection_amount
            .checked_sub(deal.inspection_released_amount)
            .ok_or(VinError::MathOverflow)?;

        // Keputusan menentukan POLA pembagian; jumlahnya tetap harus tepat habis.
        match decision {
            DECISION_REFUND_BUYER | DECISION_BOND_SLASHED => {
                require!(to_buyer == vehicle_remaining, VinError::InexactSettlement);
                require!(to_seller == 0, VinError::InexactSettlement);
            }
            DECISION_RELEASE_SELLER => {
                require!(to_seller == vehicle_remaining, VinError::InexactSettlement);
                require!(to_buyer == 0, VinError::InexactSettlement);
            }
            DECISION_SPLIT => {
                require!(
                    to_buyer.checked_add(to_seller).ok_or(VinError::MathOverflow)? == vehicle_remaining,
                    VinError::InexactSettlement
                );
            }
            _ => return err!(VinError::InvalidDecision),
        }
        require!(to_inspector <= inspection_remaining, VinError::OverRelease);
        let inspection_refund_to_buyer = inspection_remaining
            .checked_sub(to_inspector)
            .ok_or(VinError::MathOverflow)?;

        if to_buyer > 0 {
            transfer_from_deal(
                &ctx.accounts.token_program,
                &ctx.accounts.vehicle_vault.to_account_info(),
                &ctx.accounts.buyer_token.to_account_info(),
                &deal.to_account_info(),
                signer_seeds,
                to_buyer,
            )?;
            deal.vehicle_released_amount = deal
                .vehicle_released_amount
                .checked_add(to_buyer)
                .ok_or(VinError::MathOverflow)?;
        }
        if to_seller > 0 {
            transfer_from_deal(
                &ctx.accounts.token_program,
                &ctx.accounts.vehicle_vault.to_account_info(),
                &ctx.accounts.seller_token.to_account_info(),
                &deal.to_account_info(),
                signer_seeds,
                to_seller,
            )?;
            deal.vehicle_released_amount = deal
                .vehicle_released_amount
                .checked_add(to_seller)
                .ok_or(VinError::MathOverflow)?;
        }
        if to_inspector > 0 {
            transfer_from_deal(
                &ctx.accounts.token_program,
                &ctx.accounts.inspection_vault.to_account_info(),
                &ctx.accounts.inspector_token.to_account_info(),
                &deal.to_account_info(),
                signer_seeds,
                to_inspector,
            )?;
        }
        if inspection_refund_to_buyer > 0 {
            transfer_from_deal(
                &ctx.accounts.token_program,
                &ctx.accounts.inspection_vault.to_account_info(),
                &ctx.accounts.buyer_token.to_account_info(),
                &deal.to_account_info(),
                signer_seeds,
                inspection_refund_to_buyer,
            )?;
        }
        deal.inspection_released_amount = deal
            .inspection_released_amount
            .checked_add(to_inspector)
            .ok_or(VinError::MathOverflow)?
            .checked_add(inspection_refund_to_buyer)
            .ok_or(VinError::MathOverflow)?;

        // Setelah putusan, saldo kedua leg harus habis sampai nol.
        require!(
            deal.vehicle_released_amount == deal.vehicle_amount,
            VinError::InexactSettlement
        );
        require!(
            deal.inspection_released_amount == deal.inspection_amount,
            VinError::InexactSettlement
        );

        deal.frozen = false;
        match decision {
            DECISION_REFUND_BUYER | DECISION_BOND_SLASHED => deal.cancelled = true,
            _ => deal.completed = true,
        }

        emit!(DisputeResolved {
            deal: deal.key(),
            decision,
            to_buyer,
            to_seller,
            to_inspector,
            inspection_refund_to_buyer,
            evidence_hash,
        });
        Ok(())
    }

    /// Potongan jaminan. Hanya arbiter, dan hasilnya masuk KAS SENGKETA —
    /// tidak pernah ke dompet tim platform.
    pub fn slash_bond(ctx: Context<SlashBond>, amount: u64, evidence_hash: [u8; 32]) -> Result<()> {
        require!(ctx.accounts.arbiter.key() == ctx.accounts.config.arbiter, VinError::Unauthorized);
        require!(amount > 0, VinError::ZeroAmount);

        let actor = &mut ctx.accounts.actor;
        require!(actor.bond_locked >= amount, VinError::InsufficientBond);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.dispute_fund.to_account_info(),
                    authority: actor.to_account_info(),
                },
                &[&[b"actor", actor.wallet.as_ref(), &[actor.bump]]],
            ),
            amount,
        )?;
        actor.bond_locked = actor.bond_locked.checked_sub(amount).ok_or(VinError::MathOverflow)?;
        emit!(BondSlashed {
            actor: actor.key(),
            amount,
            evidence_hash,
        });
        Ok(())
    }

    /// Registri nota. Hanya hash: root bukti, VIN hash, dan alamat asset nota
    /// (Metaplex Core) bila sudah dicetak. NFT adalah jejak klaim, bukan title.
    pub fn record_note(
        ctx: Context<RecordNote>,
        owner: Pubkey,
        note_seq: u64,
        evidence_root: [u8; 32],
        asset: Pubkey,
    ) -> Result<()> {
        require!(ctx.accounts.relayer.key() == ctx.accounts.config.relayer, VinError::Unauthorized);
        let deal = &ctx.accounts.deal;
        require!(deal.completed || deal.cancelled, VinError::DealNotFinished);
        require!(owner == deal.buyer || owner == deal.seller, VinError::Unauthorized);

        let note = &mut ctx.accounts.note;
        note.deal = deal.key();
        note.vin_hash = deal.vin_hash;
        note.owner = owner;
        note.note_seq = note_seq;
        note.evidence_root = evidence_root;
        note.asset = asset;
        note.created_at = Clock::get()?.unix_timestamp;
        note.bump = ctx.bumps.note;

        emit!(NoteRecorded {
            deal: deal.key(),
            vin_hash: deal.vin_hash,
            owner,
            evidence_root,
            asset,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Akun
// ---------------------------------------------------------------------------

const MAX_FEE_BPS: u16 = 1_000;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub arbiter: Pubkey,
    pub relayer: Pubkey,
    /// Pemilik token account penerima fee. Fee platform TIDAK PERNAH bisa
    /// diarahkan ke dompet arbiter atau relayer.
    pub fee_treasury: Pubkey,
    pub dispute_fund: Pubkey,
    pub fee_bps_vehicle: u16,
    pub fee_bps_inspection: u16,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 * 5 + 2 + 2 + 1 + 1;
}

#[account]
pub struct ActorAccount {
    pub wallet: Pubkey,
    pub role: u8,
    pub attestation: [u8; 32],
    pub revoked: bool,
    pub bond_locked: u64,
    pub bump: u8,
}

impl ActorAccount {
    pub const LEN: usize = 8 + 32 + 1 + 32 + 1 + 8 + 1;
}

#[account]
pub struct DealAccount {
    /// Hanya hash VIN yang on-chain.
    pub vin_hash: [u8; 32],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub inspector: Pubkey,
    pub vehicle_amount: u64,
    pub inspection_amount: u64,
    pub vehicle_released_amount: u64,
    pub inspection_released_amount: u64,
    pub frozen: bool,
    pub cancelled: bool,
    pub completed: bool,
    pub evidence_root: [u8; 32],
    pub bump: u8,
}

impl DealAccount {
    pub const LEN: usize = 8 + 32 + 32 * 3 + 8 * 4 + 1 * 3 + 32 + 1;
}

#[account]
pub struct NoteAccount {
    pub deal: Pubkey,
    pub vin_hash: [u8; 32],
    pub owner: Pubkey,
    pub note_seq: u64,
    pub evidence_root: [u8; 32],
    pub asset: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}

impl NoteAccount {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 32 + 32 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = Config::LEN, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = config,
        seeds = [b"dispute_fund"],
        bump
    )]
    pub dispute_fund: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = admin.key() == config.admin @ VinError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"actor", actor.wallet.as_ref()], bump = actor.bump)]
    pub actor: Account<'info, ActorAccount>,
}

#[derive(Accounts)]
pub struct RegisterActor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: hanya alamat dompet, tidak dibaca.
    pub wallet: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = ActorAccount::LEN,
        seeds = [b"actor", wallet.key().as_ref()],
        bump
    )]
    pub actor: Account<'info, ActorAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockBond<'info> {
    #[account(mut)]
    pub bonder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"actor", bonder.key().as_ref()], bump = actor.bump)]
    pub actor: Account<'info, ActorAccount>,
    #[account(mut)]
    pub bonder_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = bonder,
        token::mint = bonder_token.mint,
        token::authority = actor,
        seeds = [b"bond_vault", actor.key().as_ref()],
        bump
    )]
    pub bond_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SettleBond<'info> {
    #[account(constraint = relayer.key() == config.relayer @ VinError::Unauthorized)]
    pub relayer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"actor", actor.wallet.as_ref()], bump = actor.bump)]
    pub actor: Account<'info, ActorAccount>,
    #[account(mut, seeds = [b"bond_vault", actor.key().as_ref()], bump)]
    pub bond_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = bond_vault.mint)]
    pub actor_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(vin_hash: [u8; 32], vehicle_amount: u64, inspection_amount: u64)]
pub struct OpenDeal<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"actor", buyer.key().as_ref()], bump = buyer_actor.bump)]
    pub buyer_actor: Account<'info, ActorAccount>,
    #[account(mut, seeds = [b"actor", seller.key().as_ref()], bump = seller_actor.bump)]
    pub seller_actor: Account<'info, ActorAccount>,
    #[account(seeds = [b"actor", inspector.key().as_ref()], bump = inspector_actor.bump)]
    pub inspector_actor: Account<'info, ActorAccount>,
    /// CHECK: dompet penjual; identitas diperiksa lewat seller_actor.
    pub seller: UncheckedAccount<'info>,
    /// CHECK: dompet bengkel; identitas diperiksa lewat inspector_actor.
    pub inspector: UncheckedAccount<'info>,
    #[account(
        init,
        payer = buyer,
        space = DealAccount::LEN,
        seeds = [b"deal", vin_hash.as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub deal: Account<'info, DealAccount>,
    /// Vault dana kendaraan.
    #[account(
        init,
        payer = buyer,
        token::mint = usdc_mint,
        token::authority = deal,
        seeds = [b"vault", deal.key().as_ref(), &[LEG_VEHICLE]],
        bump
    )]
    pub vehicle_vault: Account<'info, TokenAccount>,
    /// Vault dana inspeksi — terpisah dari vault kendaraan.
    #[account(
        init,
        payer = buyer,
        token::mint = usdc_mint,
        token::authority = deal,
        seeds = [b"vault", deal.key().as_ref(), &[LEG_INSPECTION]],
        bump
    )]
    pub inspection_vault: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundLeg<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"deal", deal.vin_hash.as_ref(), buyer.key().as_ref()], bump = deal.bump)]
    pub deal: Account<'info, DealAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_VEHICLE]], bump)]
    pub vehicle_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_INSPECTION]], bump)]
    pub inspection_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vehicle_vault.mint, token::authority = buyer)]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FreezeDeal<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"deal", deal.vin_hash.as_ref(), deal.buyer.as_ref()], bump = deal.bump)]
    pub deal: Account<'info, DealAccount>,
}

#[derive(Accounts)]
pub struct ReleaseLeg<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.vin_hash.as_ref(), deal.buyer.as_ref()], bump = deal.bump)]
    pub deal: Account<'info, DealAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_VEHICLE]], bump)]
    pub vehicle_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_INSPECTION]], bump)]
    pub inspection_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vehicle_vault.mint)]
    pub seller_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = inspection_vault.mint)]
    pub inspector_token: Account<'info, TokenAccount>,
    /// Penerima fee platform. Constraint mint + authority memastikan relayer
    /// tidak bisa mengalihkan fee ke dompet lain.
    #[account(
        mut,
        token::mint = vehicle_vault.mint,
        token::authority = config.fee_treasury
    )]
    pub fee_destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RefundLeg<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.vin_hash.as_ref(), deal.buyer.as_ref()], bump = deal.bump)]
    pub deal: Account<'info, DealAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_VEHICLE]], bump)]
    pub vehicle_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_INSPECTION]], bump)]
    pub inspection_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vehicle_vault.mint)]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub arbiter: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"deal", deal.vin_hash.as_ref(), deal.buyer.as_ref()], bump = deal.bump)]
    pub deal: Account<'info, DealAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_VEHICLE]], bump)]
    pub vehicle_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", deal.key().as_ref(), &[LEG_INSPECTION]], bump)]
    pub inspection_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vehicle_vault.mint)]
    pub buyer_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = vehicle_vault.mint)]
    pub seller_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = inspection_vault.mint)]
    pub inspector_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SlashBond<'info> {
    #[account(mut)]
    pub arbiter: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"actor", actor.wallet.as_ref()], bump = actor.bump)]
    pub actor: Account<'info, ActorAccount>,
    #[account(mut, seeds = [b"bond_vault", actor.key().as_ref()], bump)]
    pub bond_vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"dispute_fund"], bump)]
    pub dispute_fund: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey, note_seq: u64, evidence_root: [u8; 32], asset: Pubkey)]
pub struct RecordNote<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"deal", deal.vin_hash.as_ref(), deal.buyer.as_ref()], bump = deal.bump)]
    pub deal: Account<'info, DealAccount>,
    // `init` (bukan init_if_needed): satu nomor nota hanya bisa dicatat SEKALI.
    // Nota adalah jejak klaim - tidak boleh bisa ditimpa.
    #[account(
        init,
        payer = relayer,
        space = NoteAccount::LEN,
        seeds = [b"note", deal.key().as_ref(), &note_seq.to_le_bytes()],
        bump
    )]
    pub note: Account<'info, NoteAccount>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

enum ReleasedField {
    Vehicle,
    Inspection,
}

#[allow(clippy::too_many_arguments)]
fn transfer_from_deal<'info>(
    token_program: &Program<'info, Token>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: from.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
            signer_seeds,
        ),
        amount,
    )
}

// ---------------------------------------------------------------------------
// Event & error
// ---------------------------------------------------------------------------

#[event]
pub struct BondLocked {
    pub actor: Pubkey,
    pub amount: u64,
    pub purpose: u8,
}

#[event]
pub struct BondReturned {
    pub actor: Pubkey,
    pub amount: u64,
    pub reason_hash: [u8; 32],
}

#[event]
pub struct BondSlashed {
    pub actor: Pubkey,
    pub amount: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct DealOpened {
    pub deal: Pubkey,
    pub vin_hash: [u8; 32],
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub inspector: Pubkey,
    pub vehicle_amount: u64,
    pub inspection_amount: u64,
}

#[event]
pub struct LegFunded {
    pub deal: Pubkey,
    pub leg: u8,
    pub amount: u64,
}

#[event]
pub struct DealFrozenEvent {
    pub deal: Pubkey,
    pub reason_hash: [u8; 32],
}

#[event]
pub struct LegReleased {
    pub deal: Pubkey,
    pub leg: u8,
    pub amount: u64,
    pub platform_fee_amount: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct LegRefunded {
    pub deal: Pubkey,
    pub leg: u8,
    pub amount: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct DisputeResolved {
    pub deal: Pubkey,
    pub decision: u8,
    pub to_buyer: u64,
    pub to_seller: u64,
    pub to_inspector: u64,
    /// Sisa leg inspeksi yang dikembalikan ke pembeli (mis. bengkel belum bekerja).
    pub inspection_refund_to_buyer: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct NoteRecorded {
    pub deal: Pubkey,
    pub vin_hash: [u8; 32],
    pub owner: Pubkey,
    pub evidence_root: [u8; 32],
    pub asset: Pubkey,
}

#[error_code]
pub enum VinError {
    #[msg("Fee di atas batas yang diizinkan")]
    FeeTooHigh,
    #[msg("Jumlah harus lebih besar dari nol")]
    ZeroAmount,
    #[msg("Leg dana tidak dikenal")]
    InvalidLeg,
    #[msg("Peran aktor tidak dikenal")]
    InvalidRole,
    #[msg("Putusan arbitrase tidak dikenal")]
    InvalidDecision,
    #[msg("Identitas aktor sudah dicabut")]
    ActorRevoked,
    #[msg("Program sedang dijeda")]
    Paused,
    #[msg("Jaminan belum dikunci atau tidak mencukupi")]
    BondRequired,
    #[msg("Saldo jaminan tidak mencukupi")]
    InsufficientBond,
    #[msg("Tidak berwenang")]
    Unauthorized,
    #[msg("Perhitungan melampaui batas")]
    MathOverflow,
    #[msg("Deal dibekukan oleh sengketa")]
    DealFrozen,
    #[msg("Deal belum dibekukan")]
    DealNotFrozen,
    #[msg("Deal sudah dibatalkan")]
    DealCancelled,
    #[msg("Deal sudah selesai")]
    DealCompleted,
    #[msg("Deal belum selesai")]
    DealNotFinished,
    #[msg("Dana melebihi jumlah yang dikunci")]
    OverFunded,
    #[msg("Pelepasan melebihi saldo leg")]
    OverRelease,
    #[msg("Alamat penerima fee tidak sesuai")]
    InvalidFeeDestination,
    #[msg("Pembagian dana tidak tepat habis: sisa dana akan tersangkut di vault")]
    InexactSettlement,
}
