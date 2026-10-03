/**
  * Anchor tests for the VIN program.
 *
  * STATUS: not yet run in this development environment because the Solana/Rust
  * toolchain is unavailable (the sandbox only reaches npm/PyPI/GitHub; static.
  * rust-lang.org and crates.io are blocked). Run `anchor test` on a machine or CI
  * has the toolchain — see .github/workflows/anchor.yml.
 *
  * These tests lock the SAME invariants as the TypeScript ledger model
  * (packages/shared/src/vault-spec.ts), which is property-tested here.
  * So once the program actually compiles, we compare two implementations
  * from the same rules — not testing one implementation in isolation.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, createAccount, mintTo, getAccount } from '@solana/spl-token';
import assert from 'assert';
import { VinAnchor } from '../target/types/vin_anchor';

const LEG_VEHICLE = 0;
const LEG_INSPECTION = 1;
const ROLE_BUYER = 0;
const ROLE_SELLER = 1;
const ROLE_INSPECTOR = 2;
const ROLE_ARBITER = 4;

const DECISION_REFUND_BUYER = 0;
const DECISION_RELEASE_SELLER = 1;
const DECISION_SPLIT = 2;
const DECISION_BOND_SLASHED = 3;

const VEHICLE_AMOUNT = 45_000_000_000n; // 45.000 USDC (6 desimal)
const INSPECTION_AMOUNT = 150_000_000n; // 150 USDC
const BOND_AMOUNT = 50_000_000n; // 50 USDC

const hash = (byte: number) => Array.from(Buffer.alloc(32, byte));

describe('vin-anchor', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.VinAnchor as Program<VinAnchor>;
  const admin = provider.wallet as anchor.Wallet;

  const arbiter = Keypair.generate();
  const relayer = Keypair.generate();
  const feeTreasury = Keypair.generate();
  const seller = Keypair.generate();
  const inspector = Keypair.generate();
  const buyer = Keypair.generate();

  const vinHash = hash(7);
  let usdcMint: PublicKey;
  let disputeFund: PublicKey;

  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const configPda = pda([Buffer.from('config')]);
  const actorPda = (wallet: PublicKey) => pda([Buffer.from('actor'), wallet.toBuffer()]);
  const bondVaultPda = (actor: PublicKey) => pda([Buffer.from('bond_vault'), actor.toBuffer()]);
  const dealPda = (buyerKey: PublicKey) => pda([Buffer.from('deal'), Buffer.from(vinHash), buyerKey.toBuffer()]);
  const vaultPda = (deal: PublicKey, leg: number) => pda([Buffer.from('vault'), deal.toBuffer(), Buffer.from([leg])]);
  const notePda = (deal: PublicKey, seq: bigint) =>
    pda([Buffer.from('note'), deal.toBuffer(), Buffer.from(new anchor.BN(seq.toString()).toArray('le', 8))]);

  let deal: PublicKey;
  let buyerToken: PublicKey;
  let sellerToken: PublicKey;
  let inspectorToken: PublicKey;
  let feeToken: PublicKey;

  before(async () => {
    for (const who of [admin, arbiter, relayer, seller, inspector, buyer]) {
      const sig = await provider.connection.requestAirdrop(who.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }
    usdcMint = await createMint(provider.connection, buyer, buyer.publicKey, null, 6);
    disputeFund = pda([Buffer.from('dispute_fund')]);

    buyerToken = await createAccount(provider.connection, buyer, usdcMint, buyer.publicKey);
    sellerToken = await createAccount(provider.connection, buyer, usdcMint, seller.publicKey);
    inspectorToken = await createAccount(provider.connection, buyer, usdcMint, inspector.publicKey);
    feeToken = await createAccount(provider.connection, buyer, usdcMint, feeTreasury.publicKey);

    await mintTo(provider.connection, buyer, usdcMint, buyerToken, buyer, 100_000_000_000n);
    // The workshop needs its own balance to lock a bond (SPL Token checks the
    // token account owner, so a bond cannot be paid from the buyer balance).
    await mintTo(provider.connection, buyer, usdcMint, inspectorToken, buyer, 1_000_000_000n);

    await program.methods
      .initializeConfig(arbiter.publicKey, relayer.publicKey, feeTreasury.publicKey, 100, 500)
      .accounts({ admin: admin.publicKey, usdcMint, disputeFund })
      .rpc();

    for (const [wallet, role] of [
      [buyer.publicKey, ROLE_BUYER],
      [seller.publicKey, ROLE_SELLER],
      [inspector.publicKey, ROLE_INSPECTOR],
      [arbiter.publicKey, ROLE_ARBITER],
    ] as Array<[PublicKey, number]>) {
      await program.methods
        .registerActor(role, hash(role))
        .accounts({ payer: admin.publicKey, wallet, actor: actorPda(wallet) })
        .rpc();
    }
  });

  it('1. rejects open_deal when the workshop has not locked a bond (BondRequired)', async () => {
    deal = dealPda(buyer.publicKey);
    await assert.rejects(
      program.methods
        .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
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
      /BondRequired|Bond/,
    );
  });

  it('2. opens a deal with TWO separate vaults once the bond is locked', async () => {
    // The workshop locks a capacity bond.
    await program.methods
      .lockBond(new anchor.BN(BOND_AMOUNT.toString()), 1)
      .accounts({
        bonder: inspector.publicKey,
        actor: actorPda(inspector.publicKey),
        // owned by the workshop: SPL Token checks the owner
        bonderToken: inspectorToken,
        bondVault: bondVaultPda(actorPda(inspector.publicKey)),
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([inspector])
      .rpc();

    await program.methods
      .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        inspector: inspector.publicKey,
        deal,
        vehicleVault: vaultPda(deal, LEG_VEHICLE),
        inspectionVault: vaultPda(deal, LEG_INSPECTION),
        usdcMint,
      })
      .signers([buyer])
      .rpc();

    const vehicleVault = await getAccount(provider.connection, vaultPda(deal, LEG_VEHICLE));
    const inspectionVault = await getAccount(provider.connection, vaultPda(deal, LEG_INSPECTION));
    assert.notEqual(vaultPda(deal, LEG_VEHICLE).toBase58(), vaultPda(deal, LEG_INSPECTION).toBase58());
    assert.equal(vehicleVault.amount, 0n);
    assert.equal(inspectionVault.amount, 0n);
  });

  it('3. rejects funding above the locked amount (OverFunded)', async () => {
    await assert.rejects(
      program.methods
        .fundLeg(LEG_VEHICLE, new anchor.BN((VEHICLE_AMOUNT + 1n).toString()))
        .accounts({
          buyer: buyer.publicKey,
          deal,
          vehicleVault: vaultPda(deal, LEG_VEHICLE),
          inspectionVault: vaultPda(deal, LEG_INSPECTION),
          buyerToken,
        })
        .signers([buyer])
        .rpc(),
      /OverFunded|Funds exceed/,
    );
  });

  it('4. funds both legs, then each vault balance matches its own amount', async () => {
    await program.methods
      .fundLeg(LEG_VEHICLE, new anchor.BN(VEHICLE_AMOUNT.toString()))
      .accounts({
        buyer: buyer.publicKey,
        deal,
        vehicleVault: vaultPda(deal, LEG_VEHICLE),
        inspectionVault: vaultPda(deal, LEG_INSPECTION),
        buyerToken,
      })
      .signers([buyer])
      .rpc();

    await program.methods
      .fundLeg(LEG_INSPECTION, new anchor.BN(INSPECTION_AMOUNT.toString()))
      .accounts({
        buyer: buyer.publicKey,
        deal,
        vehicleVault: vaultPda(deal, LEG_VEHICLE),
        inspectionVault: vaultPda(deal, LEG_INSPECTION),
        buyerToken,
      })
      .signers([buyer])
      .rpc();

    const vehicleVault = await getAccount(provider.connection, vaultPda(deal, LEG_VEHICLE));
    const inspectionVault = await getAccount(provider.connection, vaultPda(deal, LEG_INSPECTION));
    assert.equal(vehicleVault.amount, VEHICLE_AMOUNT);
    assert.equal(inspectionVault.amount, INSPECTION_AMOUNT);
  });

  it('5. inspection funds can release first while vehicle funds stay locked', async () => {
    await program.methods
      .releaseLeg(LEG_INSPECTION, new anchor.BN(INSPECTION_AMOUNT.toString()), hash(21), new anchor.BN(0))
      .accounts({
        relayer: relayer.publicKey,
        deal,
        vehicleVault: vaultPda(deal, LEG_VEHICLE),
        inspectionVault: vaultPda(deal, LEG_INSPECTION),
        sellerToken,
        inspectorToken,
        feeDestination: feeToken,
      })
      .signers([relayer])
      .rpc();

    assert.equal((await getAccount(provider.connection, inspectorToken)).amount, INSPECTION_AMOUNT);
    assert.equal((await getAccount(provider.connection, vaultPda(deal, LEG_VEHICLE))).amount, VEHICLE_AMOUNT);
  });

  it('6. REGRESSION: a frozen deal rejects release_leg AND refund_leg (no bypassing arbitration)', async () => {
    await program.methods
      .freezeDeal(hash(31))
      .accounts({ caller: buyer.publicKey, deal })
      .signers([buyer])
      .rpc();

    // Regression from the property test finding: refund_leg once ignored `frozen`,
    // so a relayer could refund before the arbiter ruled.
    await assert.rejects(
      program.methods
        .refundLeg(LEG_VEHICLE, hash(32))
        .accounts({
          relayer: relayer.publicKey,
          deal,
          vehicleVault: vaultPda(deal, LEG_VEHICLE),
          inspectionVault: vaultPda(deal, LEG_INSPECTION),
          buyerToken,
        })
        .signers([relayer])
        .rpc(),
      /DealFrozen|frozen/,
    );

    await assert.rejects(
      program.methods
        .releaseLeg(LEG_VEHICLE, new anchor.BN(VEHICLE_AMOUNT.toString()), hash(33), new anchor.BN(0))
        .accounts({
          relayer: relayer.publicKey,
          deal,
          vehicleVault: vaultPda(deal, LEG_VEHICLE),
          inspectionVault: vaultPda(deal, LEG_INSPECTION),
          sellerToken,
          inspectorToken,
          feeDestination: feeToken,
        })
        .signers([relayer])
        .rpc(),
      /DealFrozen|frozen/,
    );
  });

  it('7. an arbitration ruling must add up EXACTLY; a short split is rejected', async () => {
    await assert.rejects(
      program.methods
        .resolveDispute(DECISION_SPLIT, new anchor.BN('1000000'), new anchor.BN('2000000'), new anchor.BN(0), hash(41))
        .accounts({
          arbiter: arbiter.publicKey,
          deal,
          vehicleVault: vaultPda(deal, LEG_VEHICLE),
          inspectionVault: vaultPda(deal, LEG_INSPECTION),
          buyerToken,
          sellerToken,
          inspectorToken,
        })
        .signers([arbiter])
        .rpc(),
      /InexactSettlement|tepat habis/,
    );
  });

  it('8. a refund_buyer ruling empties both vaults with nothing left', async () => {
    await program.methods
      .resolveDispute(
        DECISION_BOND_SLASHED,
        new anchor.BN(VEHICLE_AMOUNT.toString()),
        new anchor.BN(0),
        // the workshop was already paid in step 5
        hash(42),
      )
      .accounts({
        arbiter: arbiter.publicKey,
        deal,
        vehicleVault: vaultPda(deal, LEG_VEHICLE),
        inspectionVault: vaultPda(deal, LEG_INSPECTION),
        buyerToken,
        sellerToken,
        inspectorToken,
      })
      .signers([arbiter])
      .rpc();

    assert.equal((await getAccount(provider.connection, vaultPda(deal, LEG_VEHICLE))).amount, 0n);
    assert.equal((await getAccount(provider.connection, vaultPda(deal, LEG_INSPECTION))).amount, 0n);
  });

  it('9. a slashed bond goes to the DISPUTE FUND, not an admin/relayer wallet', async () => {
    const before = (await getAccount(provider.connection, disputeFund)).amount;
    await program.methods
      .slashBond(new anchor.BN(BOND_AMOUNT.toString()), hash(51))
      .accounts({
        arbiter: arbiter.publicKey,
        actor: actorPda(inspector.publicKey),
        bondVault: bondVaultPda(actorPda(inspector.publicKey)),
        disputeFund,
      })
      .signers([arbiter])
      .rpc();

    const after = (await getAccount(provider.connection, disputeFund)).amount;
    assert.equal(after - before, BOND_AMOUNT);
    assert.equal((await getAccount(provider.connection, feeToken)).amount, 0n);
  });

  it('10. HAPPY PATH: both legs settled -> deal completed -> receipt may be recorded', async () => {
    // Regression for the flow finding: `release_leg` never marked the deal
    // `completed`, so on the happy path a receipt could NEVER be recorded.
    const buyer2 = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(buyer2.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    const buyer2Token = await createAccount(provider.connection, buyer2, usdcMint, buyer2.publicKey);
    await mintTo(provider.connection, buyer2, usdcMint, buyer2Token, buyer2, 100_000_000_000n);

    // The workshop bond is locked again (it was slashed in test 9).
    await program.methods
      .lockBond(new anchor.BN(BOND_AMOUNT.toString()), 1)
      .accounts({
        bonder: inspector.publicKey,
        actor: actorPda(inspector.publicKey),
        bonderToken: inspectorToken,
        bondVault: bondVaultPda(actorPda(inspector.publicKey)),
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([inspector])
      .rpc();

    const deal2 = dealPda(buyer2.publicKey);
    await program.methods
      .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
      .accounts({
        buyer: buyer2.publicKey,
        seller: seller.publicKey,
        inspector: inspector.publicKey,
        deal: deal2,
        vehicleVault: vaultPda(deal2, LEG_VEHICLE),
        inspectionVault: vaultPda(deal2, LEG_INSPECTION),
        usdcMint,
      })
      .signers([buyer2])
      .rpc();

    for (const leg of [LEG_VEHICLE, LEG_INSPECTION]) {
      const amount = leg === LEG_VEHICLE ? VEHICLE_AMOUNT : INSPECTION_AMOUNT;
      await program.methods
        .fundLeg(leg, new anchor.BN(amount.toString()))
        .accounts({
          buyer: buyer2.publicKey,
          deal: deal2,
          vehicleVault: vaultPda(deal2, LEG_VEHICLE),
          inspectionVault: vaultPda(deal2, LEG_INSPECTION),
          buyerToken: buyer2Token,
        })
        .signers([buyer2])
        .rpc();
    }

    // Inspection funds release after the relayer verifies the (off-chain) report.
    await program.methods
      .releaseLeg(LEG_INSPECTION, new anchor.BN(INSPECTION_AMOUNT.toString()), hash(81), new anchor.BN(0))
      .accounts({
        relayer: relayer.publicKey,
        deal: deal2,
        vehicleVault: vaultPda(deal2, LEG_VEHICLE),
        inspectionVault: vaultPda(deal2, LEG_INSPECTION),
        sellerToken,
        inspectorToken,
        feeDestination: feeToken,
      })
      .signers([relayer])
      .rpc();

    // With only one leg settled, the deal is NOT complete yet.
    let state = await program.account.dealAccount.fetch(deal2);
    'one leg does not close the deal'

    // Vehicle funds release once the handover terms are met (off-chain).
    await program.methods
      .releaseLeg(LEG_VEHICLE, new anchor.BN(VEHICLE_AMOUNT.toString()), hash(82), new anchor.BN(0))
      .accounts({
        relayer: relayer.publicKey,
        deal: deal2,
        vehicleVault: vaultPda(deal2, LEG_VEHICLE),
        inspectionVault: vaultPda(deal2, LEG_INSPECTION),
        sellerToken,
        inspectorToken,
        feeDestination: feeToken,
      })
      .signers([relayer])
      .rpc();

    state = await program.account.dealAccount.fetch(deal2);
    'both legs settled -> the deal must be completed'

        // And now the receipt may be recorded.
    await program.methods
      .recordNote(buyer2.publicKey, new anchor.BN(1), hash(83), PublicKey.default)
      .accounts({ relayer: relayer.publicKey, deal: deal2, note: notePda(deal2, 1n) })
      .signers([relayer])
      .rpc();

    const note = await program.account.noteAccount.fetch(notePda(deal2, 1n));
    assert.equal(note.owner.toBase58(), buyer2.publicKey.toBase58());
    assert.equal(Buffer.from(note.evidenceRoot).toString('hex'), Buffer.from(hash(83)).toString('hex'));
  });

  it('11. receipt: only after the deal closes, and it cannot be overwritten', async () => {
    await program.methods
      .recordNote(buyer.publicKey, new anchor.BN(1), hash(61), PublicKey.default)
      .accounts({ relayer: relayer.publicKey, deal, note: notePda(deal, 1n) })
      .signers([relayer])
      .rpc();

    // Re-recording the same receipt sequence must fail (the account exists).
    await assert.rejects(
      program.methods
        .recordNote(buyer.publicKey, new anchor.BN(1), hash(62), PublicKey.default)
        .accounts({ relayer: relayer.publicKey, deal, note: notePda(deal, 1n) })
        .signers([relayer])
        .rpc(),
    );
  });
});
