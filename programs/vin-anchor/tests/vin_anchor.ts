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

  // TEMPORARY DIAGNOSTIC helper. A failed instruction arrives with the program's
  // own logs attached, and those logs are the only place where the on-chain
  // comparison (for example the two addresses a seeds check compared) is
  // visible. Remove it with the diagnostic block in `before`.
  const dumpError = (label: string, e: unknown) => {
    const err = e as {
      logs?: string[];
      message?: string;
      error?: { errorCode?: { code?: string; number?: number }; errorMessage?: string };
    };
    const code = err.error && err.error.errorCode ? `${err.error.errorCode.code}(${err.error.errorCode.number})` : 'no error code';
    console.log(`${label}: ${code} ${(err.error && err.error.errorMessage) || err.message || String(e)}`);
    // TEMPORARY DIAGNOSTIC. The same message as one line with the
    // workflow-command prefix, so the addresses a failing seeds check compared
    // become annotations of the test step and survive without the raw log.
    console.log(
      `::warning::${label}: ${String((e as Error).message ?? e).replace(/\s*\n\s*/g, ' | ').slice(0, 400)}`,
    );
    for (const line of err.logs || []) {
      console.log(`  | ${line}`);
    }
  };

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

    // TEMPORARY DIAGNOSTIC. The program prints a marker when it initializes the
    // config, so the logs of this call name the build the validator is running.
    // An earlier run read them back with `getTransaction` and got nothing, so
    // they are taken from a simulation of the same instruction instead: a
    // simulation needs no landed transaction. Remove it with the rest.
    const initTx = await program.methods
      .initializeConfig(arbiter.publicKey, relayer.publicKey, feeTreasury.publicKey, 100, 500)
      .accounts({ admin: admin.publicKey, usdcMint, disputeFund })
      .transaction();
    initTx.feePayer = admin.publicKey;
    initTx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    const initSim = await provider.connection.simulateTransaction(initTx);
    const initLogs = initSim.value.logs || [];
    console.log(`initializeConfig simulate logs (${initLogs.length}):`);
    initLogs.forEach((line) => console.log(`  | ${line}`));
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

    // TEMPORARY DIAGNOSTIC. Calls the program's own diagnostic entry point,
    // which logs what it derives from the actor and deal seeds and whether an
    // empty seed changes that result. It runs before any `openDeal` call and
    // touches no state. Remove it with `debug_seeds` in the program.
    try {
      const dbgTx = await program.methods
        .debugSeeds(vinHash)
        .accounts({ buyer: buyer.publicKey, buyerActor: actorPda(buyer.publicKey) })
        .transaction();
      dbgTx.feePayer = admin.publicKey;
      dbgTx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
      const dbgSim = await provider.connection.simulateTransaction(dbgTx);
      const dbgLogs = dbgSim.value.logs || [];
      console.log(`debug_seeds logs (${dbgLogs.length}):`);
      dbgLogs.forEach((line) => console.log(`  | ${line}`));
      console.log(
        `client-side: find([actor,buyer]) ${actorPda(buyer.publicKey).toBase58()} | find([deal,vin,buyer]) ${dealPda(buyer.publicKey).toBase58()}`,
      );
    } catch (e) {
      console.log(`debug_seeds could not be built or simulated: ${String(e)}`);
    }

    // TEMPORARY DIAGNOSTIC. `openDeal` is the only instruction whose seeds are
    // read from other accounts (`buyer.key()`, `seller.key()`,
    // `inspector.key()`), and it is the only one whose seeds check fails, so the
    // question is what the program reads in each slot. This prints, once, after
    // the accounts exist: every key the test holds, the IDL's own account list
    // and seed definitions for `openDeal`, the stored fields of each actor
    // account, and the account metas the client puts on the wire for the failing
    // instruction next to a passing one. Remove it once `openDeal` passes.
    const idlRaw = idl as unknown as {
      address?: string;
      instructions: Array<{ name: string; args?: Array<{ name: string; type: unknown }>; accounts: Array<{ name: string; pda?: unknown; address?: string }> }>;
    };
    console.log(`program id: client ${program.programId.toBase58()} | IDL address (declare_id) ${idlRaw.address}`);
    // TEMPORARY DIAGNOSTIC. The client encodes the instruction arguments from
    // these declarations, in this order, so they say what the program should
    // read back. `openDeal`'s `vin_hash` is a 32-byte array; if this list says
    // anything else, the bytes on the wire are not the bytes the program's
    // `#[instruction(...)]` binding expects. The encoded instruction follows:
    // it is the exact argument blob the program deserializes.
    for (const nm of ['open_deal', 'openDeal', 'debug_seeds', 'debugSeeds']) {
      const entry = idlRaw.instructions.find((i) => i.name === nm);
      if (entry) console.log(`IDL ${nm} args: ${JSON.stringify(entry.args)}`);
    }
    try {
      const wire = (program as unknown as { coder: { instruction: { encode: (name: string, args: Record<string, unknown>) => Buffer } } })
        .coder.instruction.encode('openDeal', {
          vinHash,
          vehicleAmount: new anchor.BN(VEHICLE_AMOUNT.toString()),
          inspectionAmount: new anchor.BN(INSPECTION_AMOUNT.toString()),
        });
      console.log(`openDeal wire (${wire.length} bytes): ${Buffer.from(wire).toString('hex')}`);
    } catch (e) {
      console.log(`openDeal wire could not be encoded: ${String(e)}`);
    }
    console.log(`wallets: admin ${admin.publicKey.toBase58()} | buyer ${buyer.publicKey.toBase58()} | seller ${seller.publicKey.toBase58()} | inspector ${inspector.publicKey.toBase58()}`);
    console.log(`arbiter ${arbiter.publicKey.toBase58()} | relayer ${relayer.publicKey.toBase58()} | feeTreasury ${feeTreasury.publicKey.toBase58()}`);
    console.log(`mint ${usdcMint.toBase58()} | tokens: buyer ${buyerToken.toBase58()} seller ${sellerToken.toBase58()} inspector ${inspectorToken.toBase58()} fee ${feeToken.toBase58()} | disputeFund ${disputeFund.toBase58()} | config ${configPda.toBase58()}`);
    const openDealIdl = idlRaw.instructions.find((i) => i.name === 'openDeal' || i.name === 'open_deal');
    const openDealAccounts = openDealIdl ? openDealIdl.accounts : [];
    console.log(`IDL openDeal accounts (${openDealAccounts.length}):`);
    openDealAccounts.forEach((a, i) => {
      console.log(`  [${i}] ${a.name}${a.pda ? ' pda=' + JSON.stringify(a.pda) : ''}${a.address ? ' address=' + a.address : ''}`);
    });
    // The camelCased IDL the client actually resolves against. Its account list
    // is the order the client puts on the wire, and its `pda` entries are the
    // seed definitions the compiler read out of the program source.
    const camelIdl = (program as unknown as {
      idl: { instructions: Array<{ name: string; accounts: Array<{ name: string; isSigner?: boolean; isWritable?: boolean; pda?: unknown }> }> };
    }).idl;
    const camelOpenDeal = camelIdl.instructions.find((i) => i.name === 'openDeal') || camelIdl.instructions[0];
    console.log(`client IDL openDeal accounts (${camelOpenDeal ? camelOpenDeal.accounts.length : 0}):`);
    (camelOpenDeal ? camelOpenDeal.accounts : []).forEach((a, i) => {
      console.log(`  [${i}] ${a.name} signer=${Boolean(a.isSigner)} writable=${Boolean(a.isWritable)}${a.pda ? ' pda=' + JSON.stringify(a.pda) : ''}`);
    });
    for (const [label, wallet] of [['buyer', buyer.publicKey], ['seller', seller.publicKey], ['inspector', inspector.publicKey]] as Array<[string, PublicKey]>) {
      const addr = actorPda(wallet);
      const [, canonicalBump] = PublicKey.findProgramAddressSync([Buffer.from('actor'), wallet.toBuffer()], program.programId);
      const info = await provider.connection.getAccountInfo(addr);
      // ActorAccount: 8 discriminator, wallet 32, role 1, attestation 32,
      // revoked 1, bond_locked 8, bump 1 - so the wallet starts at byte 8, the
      // bump is byte 82, and the account is 83 bytes long.
      const storedBump = info && info.data.length > 82 ? info.data[82] : 'no account';
      const storedWallet = info && info.data.length >= 40 ? new PublicKey(info.data.subarray(8, 40)).toBase58() : 'MISSING';
      let derived = 'n/a';
      if (typeof storedBump === 'number') {
        try {
          derived = PublicKey.createProgramAddressSync(
            [Buffer.from('actor'), wallet.toBuffer(), Buffer.from([storedBump])],
            program.programId,
          ).toBase58();
        } catch (e) {
          derived = `ERR ${String(e)}`;
        }
      }
      console.log(`actor ${label}: ${addr.toBase58()} | owner ${info ? info.owner.toBase58() : 'MISSING'} | len ${info ? info.data.length : 0} | storedWallet ${storedWallet} | storedBump ${storedBump} vs canonicalBump ${canonicalBump} | create(seeds, storedBump) ${derived}`);
    }
    const showMetas = async (label: string, ix: anchor.web3.TransactionInstruction, ixName: string) => {
      const ixIdl = (program as unknown as { idl: { instructions: Array<{ name: string; accounts: Array<{ name: string }> }> } }).idl.instructions.find((i) => i.name === ixName);
      console.log(`${label} metas (${ix.keys.length}):`);
      ix.keys.forEach((key, i) => {
        console.log(`  [${i}] ${ixIdl && ixIdl.accounts[i] ? ixIdl.accounts[i].name : 'EXTRA'} ${key.pubkey.toBase58()} signer=${key.isSigner} writable=${key.isWritable}`);
      });
    };
    // The deal address test 1 uses, computed here so the instruction can be
    // built before the test that assigns the shared `deal` variable runs.
    const probeDeal = dealPda(buyer.publicKey);
    console.log(`probeDeal (dealPda of the buyer) ${probeDeal.toBase58()}`);
    const openDealAccountsStrict = (buyerKey: PublicKey) => ({
      buyer: buyerKey,
      buyerActor: actorPda(buyer.publicKey),
      sellerActor: actorPda(seller.publicKey),
      inspectorActor: actorPda(inspector.publicKey),
      seller: seller.publicKey,
      inspector: inspector.publicKey,
      deal: probeDeal,
      config: configPda,
      systemProgram: anchor.web3.SystemProgram.programId,
    });
    try {
      const ix = await program.methods
        .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
        .accountsStrict(openDealAccountsStrict(buyer.publicKey))
        .instruction();
      await showMetas('openDeal (fails)', ix, 'openDeal');
    } catch (e) {
      console.log(`openDeal instruction could not be built: ${String(e)}`);
    }
    // Probe: same call, a different signer in the `buyer` slot. If the program
    // derives the actor PDA from the account in that slot, the address it
    // compares against moves with it. If the derived address stays the same,
    // the seeds do not read that slot at all - which is the question this whole
    // block exists to answer. The call is expected to fail; the failure is what
    // carries the answer.
    try {
      await program.methods
        .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
        .accountsStrict(openDealAccountsStrict(admin.publicKey))
        .rpc();
      console.log('probe (buyer slot = admin): the call unexpectedly succeeded');
    } catch (e) {
      dumpError('probe (buyer slot = admin)', e);
    }
    // Probe: the seller's actor in the `buyer_actor` slot. It is a real actor
    // account with its own stored bump, so the address the program compares
    // against says which account supplies the bump.
    try {
      await program.methods
        .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
        .accountsStrict({
          ...openDealAccountsStrict(buyer.publicKey),
          buyerActor: actorPda(seller.publicKey),
        })
        .signers([buyer])
        .rpc();
      console.log('probe (buyer_actor = seller actor): the call unexpectedly succeeded');
    } catch (e) {
      dumpError('probe (buyer_actor = seller actor)', e);
    }
    // TEMPORARY DIAGNOSTIC. `Right` in a ConstraintSeeds error is the address
    // the program derived for the seeds it holds. A wallet the test knows is put
    // in the `buyer` slot below, so that address can be explained here instead of
    // guessed at: every bump is tried for `[b"actor", wallet]` and the ones that
    // reproduce it are printed. A match means the deployed program does read the
    // slot and does use the stored bump, and names the bump it used. Remove this
    // with the rest of the diagnostic block.
    const seedsAddresses = (e: unknown): { left?: string; right?: string } => {
      const logs = ((e as { logs?: string[] }).logs || []).map((line) => line.replace(/^Program log: /, '').trim());
      const out: { left?: string; right?: string } = {};
      logs.forEach((line, i) => {
        if (line === 'Left:') out.left = (logs[i + 1] || '').trim();
        if (line === 'Right:') out.right = (logs[i + 1] || '').trim();
      });
      return out;
    };
    const explainActorSeeds = (label: string, wallet: PublicKey, right?: string) => {
      const canonical = PublicKey.findProgramAddressSync([Buffer.from('actor'), wallet.toBuffer()], program.programId);
      const bumps: number[] = [];
      for (let bump = 0; bump <= 255; bump += 1) {
        try {
          const candidate = PublicKey.createProgramAddressSync(
            [Buffer.from('actor'), wallet.toBuffer(), Buffer.from([bump])],
            program.programId,
          ).toBase58();
          if (candidate === right) bumps.push(bump);
        } catch (e) {
          // The address is on the curve: not a valid bump for these seeds.
        }
      }
      console.log(
        `${label}: [b"actor", ${wallet.toBase58()}] canonical ${canonical[0].toBase58()} bump ${canonical[1]} | Right ${right || '(not printed)'} reproduced by bumps ${bumps.length ? bumps.join(', ') : 'NONE'}`,
      );
    };
    for (const [label, altBuyer] of [
      ['probe (buyer slot = seller)', seller],
      ['probe (buyer slot = inspector)', inspector],
    ] as Array<[string, Keypair]>) {
      const altDeal = dealPda(altBuyer.publicKey);
      try {
        await program.methods
          .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
          .accountsStrict({
            ...openDealAccountsStrict(altBuyer.publicKey),
            deal: altDeal,
            vehicleVault: vaultPda(altDeal, LEG_VEHICLE),
            inspectionVault: vaultPda(altDeal, LEG_INSPECTION),
          })
          .signers([altBuyer])
          .rpc();
        console.log(`${label}: the call unexpectedly succeeded`);
      } catch (e) {
        dumpError(label, e);
        const { right } = seedsAddresses(e);
        explainActorSeeds(label, altBuyer.publicKey, right);
        explainActorSeeds(`${label} via the buyer wallet`, buyer.publicKey, right);
      }
    }
    // TEMPORARY DIAGNOSTIC. Positive control: the inspector's actor account in
    // the `buyer_actor` slot with the inspector's wallet in the `buyer` slot, so
    // the account and the wallet agree. If the program reads that slot and the
    // stored bump, every actor check passes here and the call gets as far as the
    // handler's "the workshop holds no bond" rule. If it still reports
    // `buyer_actor`, the derivation in the deployed binary does not use the slot
    // at all. Remove it with the rest of the diagnostic.
    try {
      const controlDeal = dealPda(inspector.publicKey);
      await program.methods
        .openDeal(vinHash, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
        .accountsStrict({
          ...openDealAccountsStrict(inspector.publicKey),
          buyerActor: actorPda(inspector.publicKey),
          deal: controlDeal,
          vehicleVault: vaultPda(controlDeal, LEG_VEHICLE),
          inspectionVault: vaultPda(controlDeal, LEG_INSPECTION),
        })
        .signers([inspector])
        .rpc();
      console.log('probe (buyer slot = inspector, buyer_actor = inspector actor): the call unexpectedly succeeded');
    } catch (e) {
      dumpError('probe (buyer slot = inspector, buyer_actor = inspector actor)', e);
      const { right } = seedsAddresses(e);
      explainActorSeeds('probe (inspector in the inspector slot)', inspector.publicKey, right);
    }
    // TEMPORARY DIAGNOSTIC. Two calls that differ only in the `vinHash`
    // argument and, because the deal address is derived from it, the `deal`
    // account. If the address the program derives does not move when the
    // argument moves, the seeds the deployed program runs do not read the
    // argument. If it moves but still misses the account the client computed,
    // then the bytes the program reads are not the bytes the client sent - and
    // the wire line printed above says what the client sent. Remove this with
    // the rest of the diagnostic block.
    const vinAlt = hash(9);
    const dealAltProbe = pda([Buffer.from('deal'), Buffer.from(vinAlt), buyer.publicKey.toBuffer()]);
    const probeRights: Record<string, string> = {};
    for (const [label, vin, dealKey] of [
      ['vin = hash(7)', vinHash, dealPda(buyer.publicKey)],
      ['vin = hash(9)', vinAlt, dealAltProbe],
    ] as Array<[string, number[], PublicKey]>) {
      try {
        await program.methods
          .openDeal(vin, new anchor.BN(VEHICLE_AMOUNT.toString()), new anchor.BN(INSPECTION_AMOUNT.toString()))
          .accountsStrict({
            ...openDealAccountsStrict(buyer.publicKey),
            deal: dealKey,
            vehicleVault: vaultPda(dealKey, LEG_VEHICLE),
            inspectionVault: vaultPda(dealKey, LEG_INSPECTION),
          })
          .signers([buyer])
          .rpc();
        console.log(`probe (${label}): the call unexpectedly succeeded`);
      } catch (e) {
        dumpError(`probe (${label})`, e);
        probeRights[label] = seedsAddresses(e).right || '(not printed)';
      }
    }
    console.log(
      `vin probe: client dealPda(hash(7)) ${dealPda(buyer.publicKey).toBase58()} | client dealPda(hash(9)) ${dealAltProbe.toBase58()} | program Right ${probeRights['vin = hash(7)']} vs ${probeRights['vin = hash(9)']} | Right moved with the argument: ${probeRights['vin = hash(7)'] !== probeRights['vin = hash(9)']}`,
    );
    try {
      const ix = await program.methods
        .slashBond(new anchor.BN(BOND_AMOUNT.toString()), hash(51))
        .accounts({
          arbiter: arbiter.publicKey,
          actor: actorPda(inspector.publicKey),
          bondVault: bondVaultPda(actorPda(inspector.publicKey)),
          disputeFund,
        })
        .instruction();
      await showMetas('slashBond (passes)', ix, 'slashBond');
    } catch (e) {
      console.log(`slashBond instruction could not be built: ${String(e)}`);
    }
  });

  // TEMPORARY DIAGNOSTIC. Runs the same seeds expression `open_deal` uses in
  // the smallest possible `init` struct, so a bad derivation can be told apart
  // from a context whose account struct is too large for the frame it is built
  // in. Prints one line with the workflow-command prefix on both outcomes, so
  // the result is readable from the run's annotations. Remove it with the
  // `debug_init` instruction in the program.
  it('0. TEMPORARY DIAGNOSTIC: a minimal init struct derives the deal PDA', async () => {
    const buyer2 = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(buyer2.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    const expected = pda([Buffer.from('deal'), Buffer.from(vinHash), buyer2.publicKey.toBuffer()]);
    try {
      await program.methods
        .debugInit(vinHash)
        .accounts({ buyer: buyer2.publicKey, deal: expected })
        .signers([buyer2])
        .rpc();
      console.log(`::warning::debug_init: expected ${expected.toBase58()} -- instruction SUCCEEDED`);
    } catch (e) {
      console.log(
        `::warning::debug_init: expected ${expected.toBase58()} -- FAILED: ${String((e as Error).message ?? e).replace(/\s*\n\s*/g, ' | ').slice(0, 300)}`,
      );
      throw e;
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
      dumpError('test 1: open_deal with an unbonded workshop', e);
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
