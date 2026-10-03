const anchor = require('@coral-xyz/anchor');
const BN = anchor.BN;
const mk = (ty) => new anchor.BorshCoder({
  version: '0.30.1', name: 'x', docs: [],
  instructions: [{ name: 'openDeal', discriminator: [0,0,0,0,0,0,0,0], accounts: [],
    args: [{ name: 'vinHash', type: ty }, { name: 'vehicleAmount', type: 'u64' }, { name: 'inspectionAmount', type: 'u64' }] }],
  accounts: [], types: [], events: [], errors: [], constants: [],
});
const vinHash = Array.from(Buffer.alloc(32, 7));
const args = { vinHash, vehicleAmount: new BN(0), inspectionAmount: new BN(0) };
for (const ty of [{array:['u8',32]}, 'bytes', {array:['u8',32], __b:true}]) {
  try {
    const data = mk(ty).instruction.encode('openDeal', args);
    console.log(JSON.stringify(ty), 'len=', data.length, 'hex=', data.toString('hex'));
  } catch (e) { console.log(JSON.stringify(ty), 'THREW:', e.message); }
}
// also: what does the same coder do with a Buffer input for {array:['u8',32]}?
try {
  const data = mk({array:['u8',32]}).instruction.encode('openDeal', { vinHash: Buffer.alloc(32,7), vehicleAmount: new BN(0), inspectionAmount: new BN(0) });
  console.log('array+Buffer len=', data.length, 'hex=', data.toString('hex'));
} catch (e) { console.log('array+Buffer THREW:', e.message); }
