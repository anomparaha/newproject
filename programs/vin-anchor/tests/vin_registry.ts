/**
 * Anchor tests for the Fase 1 VIN registry instructions.
 *
 * They lock the SAME two invariants the TypeScript model already property-tests
 * (packages/shared/src/onchain-rules.ts), now on-chain:
 *   - case 12: one VIN -> one active deal (a second reserve reverts), and
 *   - cases 13 & 14: odometer anomalies are measured against the HIGH-WATER
 *     mark, so a low report cannot reset the baseline and hide a later gap.
 *
 * Like vin_anchor.ts, these need the Solana/Anchor toolchain: run `anchor test`
 * (see docs/LOCAL_TEST.md) or let .github/workflows/anchor.yml run them. Each
 * test uses a distinct vinHash so its registry PDA is independent.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import assert from 'assert';
import idl from '../../../target/idl/vin_anchor.json';
import { VinAnchor } from '../../../target/types/vin_anchor';

const hash = (byte: number) => Array.from(Buffer.alloc(32, byte));

async function expectRevert(promise: Promise<unknown>, needle: string): Promise<void> {
  try {
    await promise;
    assert.fail(`expected a revert containing "${needle}", but the call succeeded`);
  } catch (err: any) {
    const message = String(err?.error?.errorCode?.code ?? err?.message ?? err);
    assert.ok(message.includes(needle), `expected error "${needle}", got: ${message}`);
  }
}

describe('vin-registry (Fase 1)', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const PROGRAM_ID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
  const program = new Program<VinAnchor>({ ...(idl as anchor.Idl), address: PROGRAM_ID.toBase58() }, provider);

  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const vinRecordPda = (vinHash: number[]) => pda([Buffer.from('vin'), Buffer.from(vinHash)]);

  const seller = Keypair.generate();

  /** Register a VIN and record its listing, ready to be reserved. */
  async function listedRecord(vinHash: number[]) {
    const vinRecord = vinRecordPda(vinHash);
    await program.methods
      .initVinRecord(vinHash, seller.publicKey)
      .accounts({ payer: provider.wallet.publicKey, vinRecord, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    await program.methods
      .recordListing()
      .accounts({ signer: seller.publicKey, vinRecord })
      .signers([seller])
      .rpc();
    return vinRecord;
  }

  it('case 12: a VIN can be reserved once; a second reserve reverts (one VIN, one deal)', async () => {
    const vinHash = hash(21);
    const vinRecord = await listedRecord(vinHash);
    const dealA = Keypair.generate().publicKey;
    const dealB = Keypair.generate().publicKey;

    await program.methods.recordReserve(dealA).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();

    await expectRevert(
      program.methods.recordReserve(dealB).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc(),
      'AlreadyReserved',
    );

    const record = await program.account.vinRecord.fetch(vinRecord);
    assert.ok(record.reservedByDeal.equals(dealA), 'the first deal keeps the reserve');
  });

  it('case 13: a report below the high-water mark flags an anomaly that only the buyer can clear', async () => {
    const vinHash = hash(22);
    const vinRecord = await listedRecord(vinHash);
    const deal = Keypair.generate().publicKey;
    await program.methods.recordReserve(deal).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();

    // Baseline 90,000 km.
    await program.methods.recordInspection(deal, new anchor.BN(90_000), hash(1)).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();
    let record = await program.account.vinRecord.fetch(vinRecord);
    assert.equal(record.anomalyPending, false, 'the first reading sets the baseline, no anomaly');

    // A later 50,000 km reading is an anomaly against the 90,000 baseline.
    await program.methods.recordInspection(deal, new anchor.BN(50_000), hash(2)).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();
    record = await program.account.vinRecord.fetch(vinRecord);
    assert.equal(record.anomalyPending, true, 'a reading below the high-water mark is flagged');
    assert.equal(Number(record.maxOdometer), 90_000, 'the high-water mark does not drop');

    // The buyer acknowledges; the pending flag clears but the baseline stays.
    await program.methods.acknowledgeAnomaly().accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();
    record = await program.account.vinRecord.fetch(vinRecord);
    assert.equal(record.anomalyPending, false, 'acknowledging clears the pending flag');
  });

  it('case 14: after a low report, a mid report is STILL an anomaly (baseline never resets)', async () => {
    const vinHash = hash(23);
    const vinRecord = await listedRecord(vinHash);
    const deal = Keypair.generate().publicKey;
    await program.methods.recordReserve(deal).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();

    await program.methods.recordInspection(deal, new anchor.BN(90_000), hash(1)).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();
    await program.methods.recordInspection(deal, new anchor.BN(50_000), hash(2)).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();
    await program.methods.acknowledgeAnomaly().accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();

    // 60,000 is above the last low reading but still below the 90,000 baseline.
    await program.methods.recordInspection(deal, new anchor.BN(60_000), hash(3)).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();
    const record = await program.account.vinRecord.fetch(vinRecord);
    assert.equal(record.anomalyPending, true, 'a low report cannot reset the baseline; 60k < 90k is still an anomaly');
    assert.equal(Number(record.maxOdometer), 90_000);
    assert.equal(Number(record.lastOdometer), 60_000);
  });

  it('reserve guards: a listing is required, and only the holding deal may release it', async () => {
    const vinHash = hash(24);
    const vinRecord = vinRecordPda(vinHash);
    await program.methods
      .initVinRecord(vinHash, seller.publicKey)
      .accounts({ payer: provider.wallet.publicKey, vinRecord, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();

    const deal = Keypair.generate().publicKey;
    // Not listed yet -> reserve must revert.
    await expectRevert(
      program.methods.recordReserve(deal).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc(),
      'NotListed',
    );

    await program.methods.recordListing().accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();
    await program.methods.recordReserve(deal).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc();

    // A different deal cannot release a reserve it does not hold.
    const otherDeal = Keypair.generate().publicKey;
    await expectRevert(
      program.methods.releaseReserve(otherDeal).accounts({ signer: seller.publicKey, vinRecord }).signers([seller]).rpc(),
      'NotReservedByDeal',
    );
  });
});
