/**
 * Uji Anchor untuk program VIN.
 *
 * STATUS: belum dijalankan di lingkungan pengembangan ini karena toolchain
 * Solana/Rust tidak tersedia (sandbox hanya membuka npm/PyPI/GitHub; static.
 * rust-lang.org dan crates.io diblokir). Jalankan `anchor test` di mesin/CI yang
 * punya toolchain — lihat .github/workflows/anchor.yml.
 *
 * Uji ini mengunci invarian yang SAMA dengan model ledger TypeScript
 * (packages/shared/src/vault-spec.ts) yang sudah diuji properti di sini.
 * Jadi saat program benar-benar dikompilasi, kita membandingkan dua implementasi
 * dari aturan yang sama — bukan menguji satu implementasi sendirian.
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
    // Bengkel butuh saldo sendiri untuk mengunci jaminan (SPL Token memeriksa
    // owner token account, jadi jaminan tidak bisa dibayar dari saldo pembeli).
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

  it('1. menolak open_deal bila bengkel belum mengunci jaminan (BondRequired)', async () => {
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
      /BondRequired|Jaminan/,
    );
  });

  it('2. membuka deal dengan DUA vault terpisah setelah jaminan terkunci', async () => {
    // Bengkel mengunci jaminan kapasitas.
    await program.methods
      .lockBond(new anchor.BN(BOND_AMOUNT.toString()), 1)
      .accounts({
        bonder: inspector.publicKey,
        actor: actorPda(inspector.publicKey),
        bonderToken: inspectorToken, // milik bengkel: SPL Token memeriksa owner
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

  it('3. menolak pendanaan yang melebihi jumlah yang dikunci (OverFunded)', async () => {
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
      /OverFunded|Dana melebihi/,
    );
  });

  it('4. mendanai kedua leg, lalu saldo vault terpisah sesuai jumlah masing-masing', async () => {
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

  it('5. uang inspeksi bisa cair lebih dulu, dana kendaraan tetap terkunci', async () => {
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

  it('6. REGRESI: deal beku menolak release_leg DAN refund_leg (tidak bisa melewati arbitrase)', async () => {
    await program.methods
      .freezeDeal(hash(31))
      .accounts({ caller: buyer.publicKey, deal })
      .signers([buyer])
      .rpc();

    // Regresi dari temuan uji properti: refund_leg sempat tidak memeriksa `frozen`,
    // sehingga relayer bisa mengembalikan dana sebelum arbiter memutuskan.
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
      /DealFrozen|dibekukan/,
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
      /DealFrozen|dibekukan/,
    );
  });

  it('7. putusan arbitrase harus TEPAT HABIS; pembagian yang kurang ditolak', async () => {
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

  it('8. putusan refund_buyer mengosongkan kedua vault tanpa sisa', async () => {
    await program.methods
      .resolveDispute(
        DECISION_BOND_SLASHED,
        new anchor.BN(VEHICLE_AMOUNT.toString()),
        new anchor.BN(0),
        new anchor.BN(0), // bengkel sudah dibayar di langkah 5
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

  it('9. potongan jaminan masuk KAS SENGKETA, bukan dompet admin/relayer', async () => {
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

  it('10. JALUR BAHAGIA: kedua leg tuntas -> deal completed -> nota boleh dicatat', async () => {
    // Regresi temuan alur: sebelumnya `release_leg` tidak pernah menandai deal
    // `completed`, sehingga pada jalur bahagia nota TIDAK PERNAH bisa dicatat.
    const buyer2 = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(buyer2.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    const buyer2Token = await createAccount(provider.connection, buyer2, usdcMint, buyer2.publicKey);
    await mintTo(provider.connection, buyer2, usdcMint, buyer2Token, buyer2, 100_000_000_000n);

    // Jaminan bengkel dikunci ulang (habis dipotong pada uji 9).
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

    // Dana inspeksi cair setelah laporan (off-chain) diverifikasi relayer.
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

    // Setelah satu leg saja, deal BELUM selesai.
    let state = await program.account.dealAccount.fetch(deal2);
    assert.equal(state.completed, false, 'satu leg belum menutup deal');

    // Dana kendaraan cair setelah syarat serah terima terpenuhi (off-chain).
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
    assert.equal(state.completed, true, 'kedua leg tuntas -> deal harus completed');

    // Dan sekarang nota boleh dicatat.
    await program.methods
      .recordNote(buyer2.publicKey, new anchor.BN(1), hash(83), PublicKey.default)
      .accounts({ relayer: relayer.publicKey, deal: deal2, note: notePda(deal2, 1n) })
      .signers([relayer])
      .rpc();

    const note = await program.account.noteAccount.fetch(notePda(deal2, 1n));
    assert.equal(note.owner.toBase58(), buyer2.publicKey.toBase58());
    assert.equal(Buffer.from(note.evidenceRoot).toString('hex'), Buffer.from(hash(83)).toString('hex'));
  });

  it('11. nota: hanya setelah deal ditutup, dan tidak bisa ditimpa', async () => {
    await program.methods
      .recordNote(buyer.publicKey, new anchor.BN(1), hash(61), PublicKey.default)
      .accounts({ relayer: relayer.publicKey, deal, note: notePda(deal, 1n) })
      .signers([relayer])
      .rpc();

    // Percobaan mencatat ulang nomor nota yang sama harus gagal (akun sudah ada).
    await assert.rejects(
      program.methods
        .recordNote(buyer.publicKey, new anchor.BN(1), hash(62), PublicKey.default)
        .accounts({ relayer: relayer.publicKey, deal, note: notePda(deal, 1n) })
        .signers([relayer])
        .rpc(),
    );
  });
});
