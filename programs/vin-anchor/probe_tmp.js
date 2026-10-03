const { PublicKey } = require('@solana/web3.js');
const crypto = require('crypto');
const PID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const buyer = new PublicKey('FEhvUFJu8GwuwSL1A1tKDc2qzQmu7xxYTnxbSrtnh8gv');
const TARGET = 'Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M';
const find = (seeds, pid = PID) => PublicKey.findProgramAddressSync(seeds, pid)[0].toBase58();
const K = (s) => new PublicKey(s);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const V = Buffer.alloc(32, 7);
const cands = {
  '32x07': V,
  'ascii 07 x16 (32B)': Buffer.from('07'.repeat(16)),
  'ascii 7 x32': Buffer.from('7'.repeat(32)),
  'ascii 7': Buffer.from('7'),
  'sha256(32x07)': crypto.createHash('sha256').update(V).digest(),
  'u32le(32)+32x07': Buffer.concat([u32le(32), V]),
  'u64le(32)+32x07': Buffer.concat([u64le(32), V]),
  'u8(32)+32x07': Buffer.concat([Buffer.from([32]), V]),
  'empty': Buffer.alloc(0),
  '32x00': Buffer.alloc(32, 0),
  'u64le(7)': u64le(7),
  'u32le(7)': u32le(7),
  'u8(7)': Buffer.from([7]),
  '07 then 31x00': Buffer.concat([Buffer.from([7]), Buffer.alloc(31)]),
  '31x00 then 07': Buffer.concat([Buffer.alloc(31), Buffer.from([7])]),
  'utf8 of Buffer.alloc(32, 7) str': Buffer.from('Buffer.alloc(32, 7)'),
  'utf8 "[7,7,...x32]"': Buffer.from(JSON.stringify(Array(32).fill(7))).subarray(0, 32),
  'ascii 0x07 x8': Buffer.from('0707070707070707'),
  'sha256(ascii 07 x32)': crypto.createHash('sha256').update(Buffer.from('07'.repeat(32))).digest(),
  'sha256("7")': crypto.createHash('sha256').update('7').digest(),
  '32 x u8(7) but BE decode of ascii07': Buffer.from('07'.repeat(32), 'hex'),
};
let hits = 0;
for (const [name, x] of Object.entries(cands)) {
  if (x.length > 32) { console.log('skip (too long)', name, x.length); continue; }
  const got = find([Buffer.from('deal'), x, buyer.toBuffer()]);
  if (got === TARGET) { console.log('*** HIT X=', name, got); hits++; }
}
const altW = {
  'buyer_actor': find([Buffer.from('actor'), buyer.toBuffer()]),
  'buyer': buyer.toBase58(),
  'config': find([Buffer.from('config')]),
  'pid': PID.toBase58(),
};
for (const [name, w] of Object.entries(altW)) {
  try { const got = find([Buffer.from('deal'), V, K(w).toBuffer()]); if (got === TARGET) { console.log('*** HIT X=32x07 wallet=', name, got); hits++; } } catch (e) {}
}
// Does target equal find([deal, 32x07, buyer]) under a *different* known program id?
const altPids = {
  'ATA pgm': 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'token pgm': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
for (const [name, pid] of Object.entries(altPids)) {
  try { const got = find([Buffer.from('deal'), V, buyer.toBuffer()], new PublicKey(pid)); if (got === TARGET) { console.log('*** HIT pid=', name, got); hits++; } } catch (e) {}
}
console.log('hits =', hits);
