const { PublicKey } = require('@solana/web3.js');
const PID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const K = (s) => new PublicKey(s);
const find = (seeds, pid = PID) => PublicKey.findProgramAddressSync(seeds, pid)[0].toBase58();
const buyer = K('FEhvUFJu8GwuwSL1A1tKDc2qzQmu7xxYTnxbSrtnh8gv');
const targets = {
  'c0c952f buyer-slot': 'Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M',
  'c0c952f admin-probe': 'A5p6jxq1gwGMCNcR2Ud8DFQkhi14Avq9GDi72LzjMtoy',
  'c0c952f seller-probe': 'HRUYLuni1vQz1y65aDcLLrx1Kf4wr92iw3owv2sgi6Fc',
  'c0c952f inspector-probe': 'AhFYTA6NPXFrFTfakHBL1A2oNBovjsRxa4JqLh7aMSaz',
  '233b99d seller-probe': 'A6jLr4sTabFz1b5vc8FvcLYUCfcKG2WgQYKKnGTkkYue',
  '233b99d admin-probe': 'CXdLoLrbysekubqypo1NVcxzeNKCBEAXdN24e8egKGW9',
};
const T = new Set(Object.values(targets));
const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const V = Buffer.alloc(32, 7), VEH = le64(45_000_000_000), INSP = le64(150_000_000);
// wire orders: permutations of the three args; program (attribute order vin-first) reads first 32 bytes as `vin`
const wireOrders = {
  '[vin][veh][insp] (handler order)': [V, VEH, INSP],
  '[vin][insp][veh]': [V, INSP, VEH],
  '[veh][vin][insp]': [VEH, V, INSP],
  '[veh][insp][vin]': [VEH, INSP, V],
  '[insp][vin][veh]': [INSP, V, VEH],
  '[insp][veh][vin]': [INSP, VEH, V],
};
let hitCount = 0;
for (const [name, parts] of Object.entries(wireOrders)) {
  const wire = Buffer.concat(parts);
  const vinSeen = wire.subarray(0, 32);
  const vehSeen = wire.readBigUInt64LE(32), inspSeen = wire.readBigUInt64LE(40);
  const got = find([Buffer.from('deal'), vinSeen, buyer.toBuffer()]);
  const tag = T.has(got) ? '*** HIT' : '     ';
  if (T.has(got)) hitCount++;
  console.log(`${tag} wire=${name} -> vin=${vinSeen.toString('hex')} veh=${vehSeen} insp=${inspSeen} deal=${got}`);
}
console.log('hits =', hitCount);
