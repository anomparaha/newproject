const { PublicKey } = require('@solana/web3.js');
const PID = new PublicKey('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
const K = (s) => new PublicKey(s);
const find = (seeds, pid = PID) => PublicKey.findProgramAddressSync(seeds, pid)[0].toBase58();
const B = Buffer.from;
const buyer = K('FEhvUFJu8GwuwSL1A1tKDc2qzQmu7xxYTnxbSrtnh8gv');         // c0c952f buyer wallet
const buyerActor = K('7ajVz4rtJkNXQKNbypnqYC8bVHAPVqL65NTYg97j5G3w');   // c0c952f buyer_actor
const sellerActor = K('GC67HJsj3rSabeC185jGh6Aw7grSZxAu2J4C4imNksR1');
const inspectorActor = K('HotcofaGzkwctQq6iCuPrqtqy6HCjJZkCg1RRc6z8kgm');
const dealAF = K('AFmASsq8WVBA2TU2AEw7wrCffNjyScspaKSJqxwDijqS');        // client dealPda (Left in c0c952f)
const T = {
  buyerSlot: 'Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M',
  adminProbe: 'A5p6jxq1gwGMCNcR2Ud8DFQkhi14Avq9GDi72LzjMtoy',
  sellerProbe: 'HRUYLuni1vQz1y65aDcLLrx1Kf4wr92iw3owv2sgi6Fc',
  inspectorProbe: 'AhFYTA6NPXFrFTfakHBL1A2oNBovjsRxa4JqLh7aMSaz',
  // 233b99d run rights
  sellerProbe233: 'A6jLr4sTabFz1b5vc8FvcLYUCfcKG2WgQYKKnGTkkYue',
  adminProbe233: 'CXdLoLrbysekubqypo1NVcxzeNKCBEAXdN24e8egKGW9',
};
const targets = new Set(Object.values(T));
const V = Buffer.alloc(32, 7);
const hits = (name, addr, extra='') => { if (targets.has(addr)) console.log(`*** HIT ${name} -> ${addr} ${extra}`); };
// 1) shifted-vin candidates, wallet = buyer
const shifts = {
  'u32prefix[0x20,0,0,0,7x28]': Buffer.concat([B([0x20,0,0,0]), V.subarray(0,28)]),
  'u64prefix[0x20,0,0,0,0,0,0,0,7x24]': Buffer.concat([B([0x20,0,0,0,0,0,0,0]), V.subarray(0,24)]),
  'u8prefix[32,7x31]': Buffer.concat([B([32]), V.subarray(0,31)]),
  '7x24 + veh u64 bytes': Buffer.concat([V.subarray(0,24), B([0x00,0x82,0x35,0x7a,0x0a,0x00,0x00,0x00])]),
  'veh u64 + 7x24': Buffer.concat([B([0x00,0x82,0x35,0x7a,0x0a,0x00,0x00,0x00]), V.subarray(0,24)]),
  '00x4 + 7x28': Buffer.concat([B([0,0,0,0]), V.subarray(0,28)]),
  '7x28 + 0x20,0,0,0': Buffer.concat([V.subarray(0,28), B([0x20,0,0,0])]),
};
for (const [n, x] of Object.entries(shifts)) if (x.length === 32) hits(`deal vin=${n} buyer`, find([B('deal'), x, buyer.toBuffer()]));
// 2) order/prefix permutations with the right vin
const perms = {
  '[deal, buyer, vin]': [B('deal'), buyer.toBuffer(), V],
  '[deal, vin]': [B('deal'), V],
  '[deal, vin, buyer, 0xff]': [B('deal'), V, buyer.toBuffer(), B([0xff])],
  '[vin, deal, buyer]': [V, B('deal'), buyer.toBuffer()],
};
for (const [n, s] of Object.entries(perms)) hits(`deal ${n}`, find(s));
// 3) wallet variants for [deal, vin, W]
for (const [n, w] of Object.entries({ buyer, buyerActor, sellerActor, inspectorActor, dealAF, pid: PID }))
  hits(`deal [deal,vin,${n}]`, find([B('deal'), V, w.toBuffer()]));
// 4) vault seeds of the client deal
for (const leg of [0, 1]) hits(`vaultPda(AF, ${leg})`, find([B('vault'), dealAF.toBuffer(), B([leg])]));
// 5) vault seeds of a hypothetical program-derived deal = AF (same), plus bond_vault/note/config variants
hits('bond_vault(buyerActor)', find([B('bond_vault'), buyerActor.toBuffer()]));
console.log('sweep done');
