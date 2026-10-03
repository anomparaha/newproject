const { PublicKey } = require('@solana/web3.js');
const PID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const buyer = new PublicKey('FEhvUFJu8GwuwSL1A1tKDc2qzQmu7xxYTnxbSrtnh8gv');
const find = (x) => { try { return PublicKey.findProgramAddressSync([Buffer.from('deal'), x, buyer.toBuffer()], PID)[0].toBase58(); } catch (e) { return 'ERR'; } };
const T = new Set(['Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M','A5p6jxq1gwGMCNcR2Ud8DFQkhi14Avq9GDi72LzjMtoy','HRUYLuni1vQz1y65aDcLLrx1Kf4wr92iw3owv2sgi6Fc','AhFYTA6NPXFrFTfakHBL1A2oNBovjsRxa4JqLh7aMSaz','A6jLr4sTabFz1b5vc8FvcLYUCfcKG2WgQYKKnGTkkYue','CXdLoLrbysekubqypo1NVcxzeNKCBEAXdN24e8egKGW9']);
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const V = Buffer.alloc(32, 7), VEH = le64(45_000_000_000), INSP = le64(150_000_000);
const DISC = Buffer.alloc(8, 0xd1); // any discriminator: theory needs the real one, but windows over it are unknowable; use placeholder
const parts = { vin: V, veh: VEH, insp: INSP };
const perms = [['vin','veh','insp'],['vin','insp','veh'],['veh','vin','insp'],['veh','insp','vin'],['insp','vin','veh'],['insp','veh','vin']];
let tried = 0, hits = 0;
const check = (X, label) => { tried++; const a = find(X); if (T.has(a)) { hits++; console.log(`*** HIT ${label} -> ${a}`); } };
for (const p of perms) {
  const body = Buffer.concat(p.map((k) => parts[k]));              // 48 bytes, no discriminator
  for (let off = 0; off + 32 <= 48; off++) check(body.subarray(off, off + 32), `body ${p.join('+')} off=${off}`);
  const full = Buffer.concat([DISC, body]);                        // 56 bytes
  for (let off = 0; off + 32 <= 56; off++) check(full.subarray(off, off + 32), `full ${p.join('+')} off=${off}`);
}
console.log(`windows tried=${tried} hits=${hits}`);
