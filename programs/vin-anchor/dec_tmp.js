const bs58 = require('bs58');
const chunks = [0x9b5c6aadaf3f8189n, 0x93d00fb2a3ea8385n, 0x40822e0f7479ecdfn, 0x899ad414b7be69een];
const buf = Buffer.alloc(32);
chunks.forEach((c, i) => buf.writeBigUInt64LE(c, i * 8));
const enc = bs58.default ? bs58.default.encode(buf) : bs58.encode(buf);
console.log('debug_seeds deal_addr  =', enc);
console.log('client find(deal,vin,buyer) =', 'AFmASsq8WVBA2TU2AEw7wrCffNjyScspaKSJqxwDijqS');
console.log('observed failing Right      =', 'Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M');
console.log('MATCH with client:', enc === 'AFmASsq8WVBA2TU2AEw7wrCffNjyScspaKSJqxwDijqS');
console.log('MATCH with Right :', enc === 'Czhf3XWeF6jjSdKurTS1DCkCxvDpmToi2LmpPKsdJp4M');
// also decode the buyer key and actor key chunks from the same run for a sanity check
const pair = (a,b,c,d) => { const b2 = Buffer.alloc(32); [a,b,c,d].forEach((x,i)=>b2.writeBigUInt64LE(x,i*8)); return (bs58.default?bs58.default:bs58).encode(b2); };
console.log('0x21 buyer (should be FEhvUFJu8GwuwSL1A1tKDc2qzQmu7xxYTnxbSrtnh8gv):', pair(0x502103f9217086d3n, 0x1413af404f15ef0fn, 0xe94ff9e8427743edn, 0xb71a84102c9b30cen));
console.log('0x25 actor (should be 7ajVz4rtJkNXQKNbypnqYC8bVHAPVqL65NTYg97j5G3w):', pair(0xc5a5e5d2c457ca61n, 0xcd06f882919b8bn, 0x4685c3d87055db84n, 0x46a72af0e60bab68n));
