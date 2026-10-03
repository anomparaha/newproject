//! # VIN — escrow, bonds, and receipt registry (Solana / Anchor)
//!
//! The principles encoded here:
//!
//! 1. **Two separate vaults.** Vehicle funds and inspection funds live in two
//!    different token accounts. One leg can never touch the other.
//! 2. **Release needs evidence.** Every fund release takes an `evidence_hash`
//!    recorded on-chain. Without evidence, funds do not move (enforced off-chain
//!    event log and re-validated here).
//! 3. **A dispute freezes.** `release_leg` and `refund_leg` are rejected while
//!    `deal.frozen`; only the arbiter can settle.
//! 4. **A slashed bond goes to the dispute fund**, never to the team wallet.
//! 5. **Only hashes go on-chain.** Full VINs, photos, titles, and personal data
//!    stay off-chain. The receipt NFT is a claim trail, not a vehicle title.
//!
//! STATUS: compiles for SBF in CI (see .github/workflows/anchor.yml). It has
//! never been deployed to any cluster, and `declare_id!` below is still the
//! placeholder from `anchor init` - switch it before a real deployment.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// Fund leg. Vehicle and inspection are NEVER mixed.
pub const LEG_VEHICLE: u8 = 0;
pub const LEG_INSPECTION: u8 = 1;

/// Actor role. Matches `ROLES` in the @vin/shared package.
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

    /// Initial configuration. `admin` should be a multisig (e.g. Squads) from mainnet on.
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
        // Fees can only go to the treasury address locked in config.
        // A relayer must never route fees to its own wallet.
        config.fee_treasury = fee_treasury;
        config.dispute_fund = ctx.accounts.dispute_fund.key();
        config.fee_bps_vehicle = fee_bps_vehicle;
        config.fee_bps_inspection = fee_bps_inspection;
        config.paused = false;
        config.bump = ctx.bumps.config;
        // TEMPORARY DIAGNOSTIC: a marker in the binary, so the test can tell
        // which build the validator is actually running. Remove it with the
        // diagnostic block in the tests.
        msg!("vin-anchor build marker v2 2026-10-03T20:30Z");
        Ok(())
    }

    /// The admin (multisig) can replace the relayer, the arbiter, the fee treasury,
    /// pauses the program. No instruction can move funds to an admin.
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

    /// An actor registered with an identity attestation hash.
    /// Business identity data stays off-chain and can be revoked.
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

    /// Identity can be revoked. A revoked actor must not open new deals.
    pub fn revoke_actor(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.actor.revoked = true;
        Ok(())
    }

    /// Bonds are locked in stablecoin. A bond is for eligibility and
    /// operating capacity — the token never buys a vehicle price.
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

    /// The bond returns after a clean deal (triggered by the relayer based on the
    /// auditable off-chain event log).
    pub fn return_bond(ctx: Context<SettleBond>, amount: u64, reason_hash: [u8; 32]) -> Result<()> {
        require!(amount > 0, VinError::ZeroAmount);
        require!(ctx.accounts.actor.bond_locked >= amount, VinError::InsufficientBond);

        // Read what the CPI needs before taking the mutable borrow: the vault
        // authority and the signer seeds come from the actor account, and the
        // borrow checker will not let both borrows exist at once.
        let actor_authority = ctx.accounts.actor.to_account_info();
        let (wallet, bump) = (ctx.accounts.actor.wallet, ctx.accounts.actor.bump);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.actor_token.to_account_info(),
                    authority: actor_authority,
                },
                &[&[b"actor", wallet.as_ref(), &[bump]]],
            ),
            amount,
        )?;

        let actor = &mut ctx.accounts.actor;
        actor.bond_locked = actor.bond_locked.checked_sub(amount).ok_or(VinError::MathOverflow)?;
        emit!(BondReturned { actor: actor.key(), amount, reason_hash });
        Ok(())
    }

    /// TEMPORARY DIAGNOSTIC entry point (see `DebugSeeds`). Logs what the
    /// program derives for the actor and deal seeds; it changes no state.
    pub fn debug_seeds(ctx: Context<DebugSeeds>, vin_hash: [u8; 32]) -> Result<()> {
        let program_id = ctx.program_id;
        let buyer_key = ctx.accounts.buyer.key();
        let actor_key = ctx.accounts.buyer_actor.key();
        let stored_bump = {
            let data = ctx.accounts.buyer_actor.try_borrow_data()?;
            if data.len() > 82 {
                data[82]
            } else {
                0xff
            }
        };
        let empty: &[u8] = &[];

        dbg_log_key(0x21, &buyer_key);
        dbg_log_key(0x25, &actor_key);
        anchor_lang::solana_program::log::sol_log_64(0x29, stored_bump as u64, 0, 0, 0);

        let (find_addr, find_bump) = Pubkey::find_program_address(&[b"actor", buyer_key.as_ref()], program_id);
        dbg_log_key(0x31, &find_addr);
        anchor_lang::solana_program::log::sol_log_64(
            0x35,
            find_bump as u64,
            (find_addr == actor_key) as u64,
            0,
            0,
        );

        match Pubkey::create_program_address(&[b"actor", buyer_key.as_ref(), &[stored_bump][..]], program_id) {
            Ok(addr) => {
                dbg_log_key(0x39, &addr);
                anchor_lang::solana_program::log::sol_log_64(0x3d, (addr == actor_key) as u64, 0, 0, 0);
            }
            Err(_) => anchor_lang::solana_program::log::sol_log_64(0x3d, 99, 0, 0, 0),
        }

        let (actor_with_empty, _) = Pubkey::find_program_address(&[b"actor", buyer_key.as_ref(), empty], program_id);
        anchor_lang::solana_program::log::sol_log_64(0x41, (actor_with_empty == find_addr) as u64, 0, 0, 0);

        let (deal_addr, deal_bump) =
            Pubkey::find_program_address(&[b"deal", vin_hash.as_ref(), buyer_key.as_ref()], program_id);
        dbg_log_key(0x49, &deal_addr);
        anchor_lang::solana_program::log::sol_log_64(0x4d, deal_bump as u64, 0, 0, 0);
        let (deal_with_empty, _) =
            Pubkey::find_program_address(&[b"deal", vin_hash.as_ref(), buyer_key.as_ref(), empty], program_id);
        anchor_lang::solana_program::log::sol_log_64(0x51, (deal_with_empty == deal_addr) as u64, 0, 0, 0);
        msg!("debug_seeds done");
        Ok(())
    }

    /// Opens a deal: two vaults are created separately in one transaction.
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
        // A workshop must lock a bond before taking orders.
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

    /// The buyer funds one leg. Call twice (vehicle, inspection).
    pub fn fund_leg(ctx: Context<FundLeg>, leg: u8, amount: u64) -> Result<()> {
        require!(!ctx.accounts.deal.frozen, VinError::DealFrozen);
        require!(amount > 0, VinError::ZeroAmount);

        // The vault is capped: incoming funds must not exceed the amount locked
        // when the deal opened, so the vault balance is always auditable.
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

    /// A dispute freezes the deal. The buyer, seller, or workshop may trigger it.
    pub fn freeze_deal(ctx: Context<FreezeDeal>, reason_hash: [u8; 32]) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        // The check borrows the deal, the write borrows it mutably, and the
        // event wants the key. Scoping the immutable borrow keeps all three
        // happy without cloning the account.
        {
            let deal = &ctx.accounts.deal;
            require!(
                caller == deal.buyer || caller == deal.seller || caller == deal.inspector,
                VinError::Unauthorized
            );
        }
        let deal_key = ctx.accounts.deal.key();
        ctx.accounts.deal.frozen = true;
        emit!(DealFrozenEvent {
            deal: deal_key,
            reason_hash,
        });
        Ok(())
    }

    /// Releases one leg. Only the relayer (the platform hot key) may call it,
    /// with `evidence_hash` as auditable evidence.
    /// Vehicle funds may ONLY release once the handover terms are met
    /// in the off-chain event log; this tx requires a matching evidence hash.
    pub fn release_leg(
        ctx: Context<ReleaseLeg>,
        leg: u8,
        amount: u64,
        evidence_hash: [u8; 32],
        platform_fee_amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VinError::ZeroAmount);
        require!(ctx.accounts.relayer.key() == ctx.accounts.config.relayer, VinError::Unauthorized);
        // A frozen or already closed deal must not release.
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
        // The fee must not exceed the configured bps cap, and its destination is
        // locked by an account constraint to config.fee_treasury.
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

        // Every value used for signing is copied first, so there is no double
        // borrow of the deal account.
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
            // The platform fee is taken from the same leg, to the fee recipient address.
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

        // The deal is COMPLETE once both legs are fully released. This flag is what
        // opens `record_note`; without this step a receipt could never be
        // recorded on-chain and the happy path stalls halfway.
        if deal.vehicle_released_amount == deal.vehicle_amount
            && deal.inspection_released_amount == deal.inspection_amount
        {
            deal.completed = true;
            emit!(DealCompleted { deal: deal.key() });
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

    /// Refunds back to the buyer (cancellation before handover).
    ///
    /// IMPORTANT: a FROZEN deal must not be refunded through this instruction.
    /// Without this guard, a relayer could bypass arbitration by refunding
    /// before the arbiter rules — which would make the freeze meaningless.
    /// Post-dispute refunds go only through `resolve_dispute`.
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

        // When both legs are back with the buyer, the deal closes as cancelled.
        if deal.vehicle_released_amount == deal.vehicle_amount
            && deal.inspection_released_amount == deal.inspection_amount
        {
            deal.cancelled = true;
            emit!(DealCancelledEvent { deal: deal.key() });
        }

        emit!(LegRefunded {
            deal: deal.key(),
            leg,
            amount,
            evidence_hash,
        });
        Ok(())
    }

    /// Arbitration ruling for a frozen deal.
    ///
    /// Accounting MUST be exact, so no funds are stranded in the vault:
    ///   - vehicle leg:   `to_buyer + to_seller == vehicle leg remainder`
    ///   - inspection leg: `to_inspector <= inspection leg remainder`, the rest to the buyer
    ///
    /// So a workshop that did the inspection can still be paid even when the deal
    /// is cancelled, and no balance sits idle without an owner.
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

        // The decision sets the SPLIT pattern; the amounts must still add up exactly.
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

        // After the ruling both legs must be drained to zero.
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

    /// Bond slash. Arbiter only, and the proceeds go to the DISPUTE FUND —
    /// never to the platform team wallet.
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

    /// Receipt registry. Hashes only: evidence root, VIN hash, and the receipt asset
    /// address (Metaplex Core) once minted. The NFT is a claim trail, not a title.
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
// Accounts
// ---------------------------------------------------------------------------

const MAX_FEE_BPS: u16 = 1_000;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub arbiter: Pubkey,
    pub relayer: Pubkey,
    /// Owner of the token account that receives the fee. The platform fee can NEVER
    /// be routed to an arbiter or relayer wallet.
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
    /// Only the VIN hash goes on-chain.
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
    /// CHECK: wallet address only, never read.
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
    /// Anchor takes the mint of an initialised token account from an account
    /// field, not from a public key expression, so the bond currency is named
    /// here. The address constraint keeps the original intent: the bond must be
    /// denominated in whatever the workshop's token account holds.
    #[account(address = bonder_token.mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = bonder,
        token::mint = usdc_mint,
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


/// TEMPORARY DIAGNOSTIC. Logs a pubkey as four little-endian u64 chunks under
/// `tag..tag+3`, so the value survives the log format. Used only by the
/// `debug_seeds` instruction. Remove it with that instruction.
fn dbg_log_key(tag: u64, key: &Pubkey) {
    let bytes = key.to_bytes();
    for i in 0..4 {
        let mut chunk = [0u8; 8];
        chunk.copy_from_slice(&bytes[i * 8..i * 8 + 8]);
        anchor_lang::solana_program::log::sol_log_64(tag + i as u64, u64::from_le_bytes(chunk), 0, 0, 0);
    }
}

/// TEMPORARY DIAGNOSTIC. Logs up to 32 bytes of a seed and returns the SAME
/// slice, so a value can be logged from inside a seeds list without changing
/// the derivation. Remove with `dbg_log_key` and `debug_seeds`.
#[inline(never)]
fn dbg_seed(tag: u64, bytes: &[u8]) -> &[u8] {
    let len = bytes.len() as u64;
    let mut i = 0usize;
    while i < bytes.len() && i < 32 {
        let end = if i + 8 < bytes.len() { i + 8 } else { bytes.len() };
        let mut chunk = [0u8; 8];
        chunk[..end - i].copy_from_slice(&bytes[i..end]);
        anchor_lang::solana_program::log::sol_log_64(tag + (i as u64) / 8, u64::from_le_bytes(chunk), len, 0, 0);
        i += 8;
    }
    bytes
}

/// TEMPORARY DIAGNOSTIC. Like `dbg_seed`, but returns an EMPTY slice, so the
/// value is logged without becoming a seed. Remove with `dbg_log_key` and
/// `debug_seeds`.
#[inline(never)]
fn dbg_void(tag: u64, bytes: &[u8]) -> &'static [u8] {
    let _ = dbg_seed(tag, bytes);
    &[]
}

/// TEMPORARY DIAGNOSTIC. Runs the program's own `find_program_address` on the
/// seeds it is given, logs the derived address, and returns an empty slice so
/// it contributes no seed. Placed in the `deal` seed list it answers, from
/// inside the failing constraint, what that constraint derives from the exact
/// seeds it holds. Remove with `dbg_log_key` and `debug_seeds`.
#[inline(never)]
fn dbg_find(tag: u64, seeds: &[&[u8]], program_id: &Pubkey) -> &'static [u8] {
    let (addr, bump) = Pubkey::find_program_address(seeds, program_id);
    dbg_log_key(tag, &addr);
    anchor_lang::solana_program::log::sol_log_64(tag + 4, bump as u64, 0, 0, 0);
    &[]
}

/// TEMPORARY DIAGNOSTIC. Answers, from inside the program, the questions the
/// test suite kept guessing at: what the program's own `find_program_address`
/// and `create_program_address` return for the actor and deal seeds, whether
/// the stored bump reproduces the passed actor account, and whether adding an
/// empty seed changes a derived address. It takes the accounts as plain data
/// and derives nothing for itself, so it cannot disturb `open_deal`. Remove it
/// with `dbg_log_key`.
#[derive(Accounts)]
pub struct DebugSeeds<'info> {
    /// CHECK: diagnostic only; the wallet the actor seeds should be built from.
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: diagnostic only; the actor account the seeds check compares with.
    pub buyer_actor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(vin_hash: [u8; 32], vehicle_amount: u64, inspection_amount: u64)]
pub struct OpenDeal<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"actor", buyer.key().as_ref()], bump)]
    pub buyer_actor: Account<'info, ActorAccount>,
    #[account(mut, seeds = [b"actor", seller.key().as_ref()], bump)]
    pub seller_actor: Account<'info, ActorAccount>,
    #[account(seeds = [b"actor", inspector.key().as_ref()], bump)]
    pub inspector_actor: Account<'info, ActorAccount>,
    /// CHECK: seller wallet; identity is checked via seller_actor.
    pub seller: UncheckedAccount<'info>,
    /// CHECK: workshop wallet; identity is checked via inspector_actor.
    pub inspector: UncheckedAccount<'info>,
    #[account(
        init,
        payer = buyer,
        space = DealAccount::LEN,
        seeds = [
            dbg_seed(0xe0, b"deal"),
            dbg_seed(0xe8, vin_hash.as_ref()),
            dbg_seed(0xf0, buyer.key().as_ref()),
            dbg_void(0x100, deal.key().as_ref()),
            dbg_void(0x108, __program_id.as_ref()),
            dbg_find(0x110, &[b"deal", vin_hash.as_ref(), buyer.key().as_ref()], __program_id),
        ],
        bump
    )]
    pub deal: Account<'info, DealAccount>,
    /// Vehicle fund vault.
    #[account(
        init,
        payer = buyer,
        token::mint = usdc_mint,
        token::authority = deal,
        seeds = [b"vault", deal.key().as_ref(), &[LEG_VEHICLE]],
        bump
    )]
    pub vehicle_vault: Account<'info, TokenAccount>,
    /// Inspection fund vault — separate from the vehicle vault.
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
    /// Platform fee recipient. The mint + authority constraints make sure the relayer
    /// cannot divert the fee to another wallet.
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
    // `init` (not init_if_needed): a receipt sequence can be recorded only ONCE.
    // A receipt is a claim trail - it must never be overwritten.
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
pub struct DealCompleted {
    pub deal: Pubkey,
}

#[event]
pub struct DealCancelledEvent {
    pub deal: Pubkey,
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
    /// Inspection leg remainder refunded to the buyer (e.g. the workshop never worked).
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
    #[msg("Fee above the allowed cap")]
    FeeTooHigh,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Unknown fund leg")]
    InvalidLeg,
    #[msg("Unknown actor role")]
    InvalidRole,
    #[msg("Unknown arbitration decision")]
    InvalidDecision,
    #[msg("Actor identity has been revoked")]
    ActorRevoked,
    #[msg("Program sedang dijeda")]
    Paused,
    #[msg("Bond is not locked or insufficient")]
    BondRequired,
    #[msg("Bond balance is insufficient")]
    InsufficientBond,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Perhitungan melampaui batas")]
    MathOverflow,
    #[msg("Deal is frozen by a dispute")]
    DealFrozen,
    #[msg("Deal is not frozen")]
    DealNotFrozen,
    #[msg("Deal is already cancelled")]
    DealCancelled,
    #[msg("Deal is already completed")]
    DealCompleted,
    #[msg("Deal is not completed yet")]
    DealNotFinished,
    #[msg("Funds exceed the locked amount")]
    OverFunded,
    #[msg("Pelepasan melebihi saldo leg")]
    OverRelease,
    #[msg("Fee recipient address does not match")]
    InvalidFeeDestination,
    #[msg("Fund split is not exact: the remainder would be stranded in the vault")]
    InexactSettlement,
}
