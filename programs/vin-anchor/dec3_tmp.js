const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const enc = (buf) => (bs58.default ? bs58.default.encode(buf) : bs58.encode(buf));
const PID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const K = (s) => new PublicKey(s);
const find = (seeds, pid = PID) => { try { return PublicKey.findProgramAddressSync(seeds, pid)[0].toBase58(); } catch (e) { return 'ERR'; } };
const buyer = 'FAjswNseNPnMAvwKLw2YzvUpR2BAjJvhsQbE5u1hBMaL';
const admin = '4kdDJuWD2JxPVuoxHsgzGAHVhnXArKTLRLKNtcutJWxQ';
const seller = '8tWhp8MEoA2fioqQTnFehPhgtfpmBjxvCVRgiGka6TCx';
const inspector = '7Nu8tM7ULTLV28TvoRYZ872DHTeddwuDhYV6TbVFQFJM';
const deal = 'D6dpizrdBqWBPUfVzmY5uc5tRHcofp6QFbBc4f6uYfQL';
const vault0 = 'BuRif7fgYjeC7dpitHLcQsuuKcPiQhgVYGaJcnb6SbVr';
const vault1 = 'Dv4GYJmYhnP6uejhGJNH357jJGCWmitjcNgx4pqUjtCG';
const bActor = '8hjXSrzsrwFaD8UMfQPxfxZ8fFzmbCFsGckDH73oieRa';
const sActor = 'F155SiAxNvsRCWhAZhvWCWKfgKaYQ7VSMVF8yXMqiihE';
const iActor = 'H37YFQ2zKD8ebdYk7EhQuZ1wpkm2QqhrTxkZam8kLTvu';
const config = '4rLtKGqsrPZzMgSw8mhD4G8sSqRyjWDSqrDD3aHL2VfX';
const mint = '3TCS5AUT12q6gMkrrt2YGoDXRRm3Y8NQXmnQ8D2dNxFJ';
const LEFTS = { adminProbe: 'ZDkNyXdKE5bmAW1VvEm6WdfFdKcs1kDg7DwaqMXsmPd', buyerBlock: 'ZDkNyXdKE5bmAW1VvEm6WdfFdKcs1kDgKGS1qUVPYes' };
// sanity: the client-side derivations we were told
console.log('sanity find([deal,vin,buyer]) =', find([Buffer.from('deal'), Buffer.alloc(32,7), K(buyer).toBuffer()]), '(client printed:', deal + ')');
console.log('sanity find([deal,vin,admin]) =', find([Buffer.from('deal'), Buffer.alloc(32,7), K(admin).toBuffer()]));
console.log('sanity vault0 =', find([Buffer.from('vault'), K(deal).toBuffer(), Buffer.from([0])]), '(client:', vault0 + ')');
console.log('sanity vault1 =', find([Buffer.from('vault'), K(deal).toBuffer(), Buffer.from([1])]), '(client:', vault1 + ')');
// decode the two Lefts and compare bytes
const bufA = new PublicKey(LEFTS.adminProbe).toBuffer(), bufB = new PublicKey(LEFTS.buyerBlock).toBuffer();
console.log('adminProbe Left hex:', bufA.toString('hex'));
console.log('buyerBlock Left hex:', bufB.toString('hex'));
let same = 0; while (same < 32 && bufA[same] === bufB[same]) same++;
console.log('identical leading bytes:', same);
// candidate sweep for the Lefts
const V = Buffer.alloc(32, 7);
const names = { buyer, admin, seller, inspector, deal, vault0, vault1, bActor, sActor, iActor, config, mint, pid: PID.toBase58() };
const prefixes = ['deal', 'vault', 'actor', 'bond_vault', 'note', 'config'];
const suffixes = [[], [0], [1], [255], [253]];
let hits = 0;
for (const [pn, p] of Object.entries(prefixes)) {
  for (const [kn, kk] of Object.entries(names)) {
    for (const sfx of suffixes) {
      const seeds = [Buffer.from(p), K(kk).toBuffer(), ...(sfx.length ? [Buffer.from(sfx)] : [])];
      const a = find(seeds);
      for (const [ln, lv] of Object.entries(LEFTS)) if (a === lv) { hits++; console.log(`*** HIT ${ln}: find([${p}, ${kn}, ${JSON.stringify(sfx)}]) = ${a}`); }
      const a2 = find([Buffer.from(p), K(kk).toBuffer(), V, ...(sfx.length ? [Buffer.from(sfx)] : [])]);
      for (const [ln, lv] of Object.entries(LEFTS)) if (a2 === lv) { hits++; console.log(`*** HIT ${ln}: find([${p}, ${kn}, 32x07, ${JSON.stringify(sfx)}]) = ${a2}`); }
    }
  }
}
console.log('sweep hits =', hits);
