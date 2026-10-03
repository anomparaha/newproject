const { PublicKey } = require('@solana/web3.js');
const crypto = require('crypto');
const PID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const find = (x, w) => { try { return PublicKey.findProgramAddressSync([Buffer.from('deal'), x, w], PID)[0].toBase58(); } catch (e) { return 'ERR'; } };
const buyer = new PublicKey('FEhvUFJu8GwuwSL1A1tKDc2qzQmu7xxYTnxbSrtnh8gv').toBuffer();
const T = new Set(['Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M','A5p6jxq1gwGMCNcR2Ud8DFQkhi14Avq9GDi72LzjMtoy','HRUYLuni1vQz1y65aDcLLrx1Kf4wr92iw3owv2sgi6Fc','AhFYTA6NPXFrFTfakHBL1A2oNBovjsRxa4JqLh7aMSaz','A6jLr4sTabFz1b5vc8FvcLYUCfcKG2WgQYKKnGTkkYue','CXdLoLrbysekubqypo1NVcxzeNKCBEAXdN24e8egKGW9']);
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const VEH = le64(45_000_000_000), INSP = le64(150_000_000);
const discSimple = crypto.createHash('sha256').update('global:open_deal').digest().subarray(0, 8);
console.log('disc(global:open_deal) =', discSimple.toString('hex'));
const fields = { vin: Buffer.alloc(32, 7), veh: VEH, insp: INSP };
const names = ['vin', 'veh', 'insp'];
const perms = [];
(function permute(rest, acc) { if (!rest.length) return perms.push(acc); rest.forEach((r, i) => permute(rest.filter((_, j) => j !== i), acc.concat(r))); })(names, []);
const permsIdx = perms.map((p) => p.map((n) => ['vin','veh','insp'].indexOf(n)));
let tried = 0, hits = 0;
// model: wire = permA of args (client/IDL order); program reads __Args in permB order (attribute order);
// vin = the 32-byte field's bytes in the read layout (with offset = sum of sizes of preceding fields in permB)
for (const pA of perms) {
  for (const pB of perms) {
    for (const withDisc of [false, true]) {
      const wire = Buffer.concat([...(withDisc ? [discSimple] : []), ...pA.map((n) => fields[n])]);
      const start = (withDisc ? 8 : 0);
      const body = wire.subarray(start);           // 48-byte arg blob as the program sees it
      // offset of the vin field under read layout pB
      let off = 0;
      for (const n of pB) { if (n === 'vin') break; off += n === 'vin' ? 32 : 8; }
      if (off + 32 > body.length) continue;
      const x = body.subarray(off, off + 32);
      tried++;
      const a = find(x, buyer);
      if (T.has(a)) { hits++; console.log(`*** HIT wire=[${pA.join(',')}] read=[${pB.join(',')}] disc=${withDisc} vin=${x.toString('hex')} -> ${a}`); }
    }
  }
}
console.log(`layout combos tried=${tried} hits=${hits}`);
