/**
 * Uji Anchor untuk program VIN.
 *
 * STATUS: belum dijalankan pada lingkungan pengembangan ini (tidak ada
 * toolchain Solana/Rust di sandbox). Jalankan dengan `anchor test` setelah
 * toolchain tersedia.
 *
 * Uji ini mengunci janji-janji yang sama dengan uji aturan off-chain:
 *  1. dana kendaraan & inspeksi berada di vault berbeda,
 *  2. dana tidak bisa dilepas dua kali melebihi jumlah yang dikunci,
 *  3. deal yang dibekukan menolak pelepasan,
 *  4. potongan jaminan masuk kas sengketa.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createMint, createAccount, mintTo } from '@solana/spl-token';
import assert from 'assert';
import { VinAnchor } from '../target/types/vin_anchor';

const LEG_VEHICLE = 0;
const LEG_INSPECTION = 1;
const ROLE_BUYER = 0;
const ROLE_SELLER = 1;
const ROLE_INSPECTOR = 2;

describe('vin-anchor', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.VinAnchor as Program<VinAnchor>;
  const admin = provider.wallet as anchor.Wallet;
  const arbiter = Keypair.generate();
  const relayer = Keypair.generate();

  const vinHash = Array.from(Buffer.alloc(32, 7));
  let usdcMint: PublicKey;
  let disputeFund: PublicKey;

  const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)[0];
  const actorPda = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('actor'), wallet.toBuffer()], program.programId)[0];
  const dealPda = (buyer: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from('deal'), Buffer.from(vinHash), buyer.toBuffer()], program.programId)[0];
  const vaultPda = (deal: PublicKey, leg: number) =>
    PublicKey.findProgramAddressSync([Buffer.from('vault'), deal.toBuffer(), Buffer.from([leg])], program.programId)[0];

  before(async () => {
    usdcMint = await createMint(provider.connection, (admin as any).payer, admin.publicKey, null, 6);
    disputeFund = PublicKey.findProgramAddressSync([Buffer.from('dispute_fund')], program.programId)[0];

    await program.methods
      .initializeConfig(arbiter.publicKey, relayer.publicKey, 100, 500)
      .accounts({ admin: admin.publicKey, usdcMint, disputeFund })
      .rpc();
  });

  it('mendaftarkan aktor dan menolak deal tanpa jaminan bengkel', async () => {
    const seller = Keypair.generate();
    const inspector = Keypair.generate();
    const buyer = admin;

    for (const [wallet, role] of [
      [buyer.publicKey, ROLE_BUYER],
      [seller.publicKey, ROLE_SELLER],
      [inspector.publicKey, ROLE_INSPECTOR],
    ] as Array<[PublicKey, number]>) {
      await program.methods
        .registerActor(role, Array.from(Buffer.alloc(32, role)))
        .accounts({ payer: admin.publicKey, wallet, actor: actorPda(wallet) })
        .rpc();
    }

    const deal = dealPda(buyer.publicKey);
    await assert.rejects(
      program.methods
        .openDeal(vinHash, new anchor.BN(45_000_000_000), new anchor.BN(150_000_000))
        .accounts({
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          inspector: inspector.publicKey,
          deal,
          vehicleVault: vaultPda(deal, LEG_VEHICLE),
          inspectionVault: vaultPda(deal, LEG_INSPECTION),
          usdcMint,
        })
        .rpc(),
      /BondRequired|Jaminan/,
    );
  });

  // Uji yang WAJIB ditulis sebelum mainnet (belum ada di repo ini):
  //
  //  1. lock_bond -> open_deal -> fund_leg x2 -> release_leg(inspection)
  //     -> freeze_deal -> release_leg(vehicle) HARUS gagal (DealFrozen)
  //     -> resolve_dispute(DECISION_REFUND_BUYER) oleh arbiter.
  //  2. fund_leg melebihi jumlah yang dikunci HARUS gagal (OverFunded).
  //  3. release_leg dua kali melebihi total HARUS gagal (OverRelease).
  //  4. platform_fee_amount di atas batas bps HARUS gagal (FeeTooHigh).
  //  5. slash_bond: saldo berpindah ke dispute_fund, bukan ke admin.
  //  6. revoke_actor: aktor yang dicabut tidak bisa membuka deal baru.
  //  7. record_note: hanya boleh setelah deal completed/cancelled.
  //
  // Jalankan `anchor test` di CI (lihat .github/workflows/anchor.yml).
});
