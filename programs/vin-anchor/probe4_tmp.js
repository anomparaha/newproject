const { PublicKey } = require('@solana/web3.js');
const PID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const K = (s) => new PublicKey(s);
const findRaw = (seeds, pid = PID) => { try { return PublicKey.findProgramAddressSync(seeds, pid)[0].toBase58(); } catch (e) { return 'ERR:' + e.message; } };
const buyer = K('FEhvUFJu8GwuwSL1A1tKDc2qzQmu7xxYTnxbSrtnh8gv');
const T = {
  Czhf3XWe: 'Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M',
  A5p: 'A5p6jxq1gwGMCNcR2Ud8DFQkhi14Avq9GDi72LzjMtoy',
  HRUYL: 'HRUYLuni1vQz1y65aDcLLrx1Kf4wr92iw3owv2sgi6Fc',
  AhFY: 'AhFYTA6NPXFrFTfakHBL1A2oNBovjsRxa4JqLh7aMSaz',
  A6jL: 'A6jLr4sTabFz1b5vc8FvcLYUCfcKG2WgQYKKnGTkkYue',
  CXdL: 'CXdLoLrbysekubqypo1NVcxzeNKCBEAXdN24e8egKGW9',
};
const S = new Set(Object.values(T));
const V = Buffer.alloc(32, 7), DEAL = Buffer.from('deal'), BUY = buyer.toBuffer();
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const report = (label, addr) => { if (S.has(addr)) console.log(`*** HIT ${label} -> ${addr}`); };
for (let b = 0; b < 256; b++) {
  report(`4th seed = [${b}]`, findRaw([DEAL, V, BUY, Buffer.from([b])]));
  report(`mid seed = 32x${b}`, findRaw([DEAL, Buffer.alloc(32, b), BUY]));
  report(`4th seed = le64(${b})`, findRaw([DEAL, V, BUY, le64(b)]));
  report(`mid seed = le64(${b})`, findRaw([DEAL, le64(b), BUY]));
  report(`mid seed = [${b}]`, findRaw([DEAL, Buffer.from([b]), BUY]));
}
// swapped: bump first
for (let b = 0; b < 256; b++) report(`bump first [${b}]`, findRaw([DEAL, Buffer.from([b]), V, BUY]));
console.log('bump sweeps done');
