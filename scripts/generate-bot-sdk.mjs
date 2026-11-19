import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,relative} from 'node:path';
const check=process.argv.includes('--check'),entries=JSON.parse(readFileSync('packages/bot-sdk/exports.json','utf8'));
for(const [key,target] of Object.entries(entries)){
 const file='packages/bot-sdk/src/'+key+'.ts',expected='/** Public host service; implementation stays in the host distribution. */\nexport * from '+JSON.stringify(relative(dirname(file),target).replaceAll('\\','/'))+';\n';
 if(check){if(readFileSync(file,'utf8').replaceAll('\r\n','\n').replaceAll("'",'"')!==expected)throw Error('SDK facade differs from exports.json: '+file);}
 else {mkdirSync(dirname(file),{recursive:true});writeFileSync(file,expected);}
}
