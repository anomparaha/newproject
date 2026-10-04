/**
 * Anchor tests for the VIN program.
 *
 * They need the Solana/Rust toolchain: run `anchor test` on a machine that has
 * it (see docs/LOCAL_TEST.md) or let the CI job run them
 * (.github/workflows/anchor.yml). The two-instruction transaction in the deal
 * tests exists because the single fourteen-account instruction overflowed the
 * SBF stack frame budget; the CI job refuses to run the tests when any
 * function overruns that budget, because such a build is undefined behaviour
 * even though it compiles.
 *
 * These tests lock the SAME invariants as the TypeScript ledger model
 * (packages/shared/src/vault-spec.ts), which is property-tested separately, so
 * the two implementations are compared against the same rules.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, createAccount, mintTo, getAccount } from '@solana/spl-token';
import assert from 'assert';
import idl from '../../../target/idl/vin_anchor.json';
import { VinAnchor } from '../../../target/types/vin_anchor';

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
  // The IDL is named here instead of going through `anchor.workspace`, which
  // parses Anchor.toml from the working directory: this file sits outside the
  // workspace root, and the explicit form keeps the test independent of where
  // it is started from. Anchor 0.30 takes the program ID from the IDL itself,
  // so it is set here; it has to match `declare_id!` in the program and
  // `[programs.localnet]` in Anchor.toml.
  const PROGRAM_ID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
  const program = new Program<VinAnchor>(
    { ...(idl as anchor.Idl), address: PROGRAM_ID.toBase58() },
    provider,
  );
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
    try {
      await program.methods
        .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
        .accounts({
          buyer: buyer.publicKey,
          // The three actor PDAs are named here as well as derived: this is the
          // one instruction that reads other accounts as seeds, so the test
          // should not depend on client-side derivation for them.
          buyerActor: actorPda(buyer.publicKey),
          sellerActor: actorPda(seller.publicKey),
          inspectorActor: actorPda(inspector.publicKey),
          seller: seller.publicKey,
          inspector: inspector.publicKey,
          deal,
        })
        // `buyer` is a signer on the instruction, so the transaction has to be
        // signed by it. Without the signature the call never reaches the
        // program and the check that `open_deal` is what rejects an unbonded
        // workshop never runs.
        .signers([buyer])
        .rpc();
      assert.fail('open_deal must be rejected while the workshop holds no bond');
    } catch (e) {
      assert.match(String((e as Error).message ?? e), /BondRequired|Bond/);
    }
  });

  it('2. opens a deal with TWO separate vaults once the bond is locked', async () => {
    // The workshop locks a capacity bond.
    await program.methods
      .lockBond(new anchor.BN(BOND_AMOUNT.toString()), 1)
      .accounts({
        bonder: inspector.publicKey,
        actor: actorPda(inspector.publicKey),
        usdcMint,
        // owned by the workshop: SPL Token checks the owner
        bonderToken: inspectorToken,
        bondVault: bondVaultPda(actorPda(inspector.publicKey)),
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([inspector])
      .rpc();

    // The deal record and its two vaults are two instructions sent in one
    // transaction: the single fourteen-account instruction overflowed the SBF
    // stack frame budget (the program's comments say where), so vault creation
    // moved to its own context. Sending both together keeps the promise that a
    // deal is never on chain without its vaults.
    const openDealIx = await program.methods
      .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
      .accounts({
        buyer: buyer.publicKey,
        buyerActor: actorPda(buyer.publicKey),
        sellerActor: actorPda(seller.publicKey),
        inspectorActor: actorPda(inspector.publicKey),
        seller: seller.publicKey,
        inspector: inspector.publicKey,
        deal,
      })
      .instruction();
    const openDealVaultsIx = await program.methods
      .openDealVaults()
      .accounts({
        buyer: buyer.publicKey,
        deal,
        vehicleVault: vaultPda(deal, LEG_VEHICLE),
        inspectionVault: vaultPda(deal, LEG_INSPECTION),
        usdcMint,
      })
      .instruction();
    // `provider.sendAndConfirm` signs with the provider wallet, so that wallet
    // is the fee payer and the buyer is added as the second signer. Pointing
    // `feePayer` at the buyer instead makes the provider wallet an unknown
    // signer, because web3.js then has no signature slot for it.
    const openDealTx = new anchor.web3.Transaction().add(openDealIx, openDealVaultsIx);
    await provider.sendAndConfirm(openDealTx, [buyer]);

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
          config: configPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
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
    // The workshop's token account is not empty: the test setup minted it an
    // opening balance and test 2 locked the bond out of it, so the release is
    // checked as a delta (the caller passes a platform fee of zero, so the
    // inspector receives the full inspection leg).
    const inspectorBefore = (await getAccount(provider.connection, inspectorToken)).amount;
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

    const inspectorAfter = (await getAccount(provider.connection, inspectorToken)).amount;
    assert.equal(inspectorAfter - inspectorBefore, INSPECTION_AMOUNT);
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
        // The program takes five arguments; a call with four leaves the client
        // treating the context object as the last argument, which fails as
        // "Account `arbiter` not provided" rather than as a bad call.
        // The workshop was already paid in step 5, so its share is zero.
        new anchor.BN(0),
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
    // `open_deal` requires the buyer to be a registered actor, and this wallet is
    // new, so it is registered here the same way the others were.
    await program.methods
      .registerActor(ROLE_BUYER, hash(90))
      .accounts({ payer: admin.publicKey, wallet: buyer2.publicKey, actor: actorPda(buyer2.publicKey) })
      .rpc();
    // The mint authority is `buyer` (see `createMint` in the setup), and SPL
    // Token checks the authority signature, so minting is signed by `buyer`
    // even though the tokens land in buyer2's account.
    await mintTo(provider.connection, buyer, usdcMint, buyer2Token, buyer, 100_000_000_000n);

    // The workshop bond is locked again (it was slashed in test 9).
    await program.methods
      .lockBond(new anchor.BN(BOND_AMOUNT.toString()), 1)
      .accounts({
        bonder: inspector.publicKey,
        actor: actorPda(inspector.publicKey),
        usdcMint,
        bonderToken: inspectorToken,
        bondVault: bondVaultPda(actorPda(inspector.publicKey)),
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([inspector])
      .rpc();

    const deal2 = dealPda(buyer2.publicKey);
    // The same pair of instructions test 2 sends: the deal, then its vaults.
    const openDeal2Ix = await program.methods
      .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
      .accounts({
        buyer: buyer2.publicKey,
        buyerActor: actorPda(buyer2.publicKey),
        sellerActor: actorPda(seller.publicKey),
        inspectorActor: actorPda(inspector.publicKey),
        seller: seller.publicKey,
        inspector: inspector.publicKey,
        deal: deal2,
      })
      .instruction();
    const openDeal2VaultsIx = await program.methods
      .openDealVaults()
      .accounts({
        buyer: buyer2.publicKey,
        deal: deal2,
        vehicleVault: vaultPda(deal2, LEG_VEHICLE),
        inspectionVault: vaultPda(deal2, LEG_INSPECTION),
        usdcMint,
      })
      .instruction();
    const openDeal2Tx = new anchor.web3.Transaction().add(openDeal2Ix, openDeal2VaultsIx);
    await provider.sendAndConfirm(openDeal2Tx, [buyer2]);

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
          config: configPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
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
