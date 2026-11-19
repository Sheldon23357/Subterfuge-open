// Deterministic development oracle only. Neither client invokes JavaScript.
// Expected output is ECMAScript binary64 serialization required by RFC 8785.
import {writeFileSync} from 'node:fs';
const edge=['0000000000000000','8000000000000000','0000000000000001','8000000000000001','7fefffffffffffff','ffefffffffffffff','4340000000000000','c340000000000000','4430000000000000','44b52d02c7e14af5','44b52d02c7e14af6','44b52d02c7e14af7','444b1ae4d6e2ef4e','444b1ae4d6e2ef4f','444b1ae4d6e2ef50','3eb0c6f7a0b5ed8c','3eb0c6f7a0b5ed8d','41b3de4355555553','41b3de4355555554','41b3de4355555555','41b3de4355555556','41b3de4355555557'];
let seed=0x123456789abcdef0n;const mask=(1n<<64n)-1n;const hexes=[...edge];
for(let i=0;i<1024;i++){seed^=(seed<<13n)&mask;seed^=seed>>7n;seed^=(seed<<17n)&mask;seed&=mask;hexes.push(seed.toString(16).padStart(16,'0'));}
const vectors=hexes.map(hex=>{const n=Buffer.from(hex,'hex').readDoubleBE();return Number.isFinite(n)?{hex,canonical:JSON.stringify(n)}:null;}).filter(Boolean);
writeFileSync(new URL('number-vectors.json',import.meta.url),JSON.stringify(vectors,null,2)+'\n');
console.log(`${vectors.length} finite number vectors written`);
