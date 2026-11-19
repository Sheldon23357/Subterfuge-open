import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
const root=dirname(fileURLToPath(import.meta.url)),manifest=JSON.parse(readFileSync(join(root,'HOST-MANIFEST.json'),'utf8'));
if(process.platform!==manifest.platform||process.arch!==manifest.arch)throw Error(`This distribution targets ${manifest.platform}/${manifest.arch}; download a matching build.`);
for(const [file,expected]of Object.entries(manifest.files)){const actual=createHash('sha256').update(readFileSync(join(root,file))).digest('hex');if(actual!==expected)throw Error('Host file changed: '+file+'; restore the original distribution.');}
const supplied=process.argv.slice(2);
async function defaultPort(){
 const port=await new Promise((done,reject)=>{
  const probe=createServer();
  probe.on('error',error=>{if(error.code==='EADDRINUSE')probe.listen(0,'127.0.0.1');else reject(error);});
  probe.on('listening',()=>{const port=probe.address().port;probe.close(error=>error?reject(error):done(port));});
  probe.listen(4400,'127.0.0.1');
 });
 if(port!==4400)console.log('Default port 4400 is busy; using port '+port+'.');
 return String(port);
}
const args=[join(root,'runtime/agent-cli.mjs'),
 ...(!supplied.includes('--console')?['--console',await defaultPort()]:[]),
 ...(!supplied.includes('--config')&&!supplied.includes('--store-directory')?['--store-directory',join(root,'data')]:[]),
 ...(!supplied.includes('--console-web-root')?['--console-web-root',join(root,'web')]:[]),
 ...(!supplied.includes('--plugin-directory')?['--plugin-directory',join(root,'plugins')]:[]),...supplied];
const child=spawn(process.execPath,args,{cwd:root,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.once('exit',code=>{process.exitCode=code??1;});child.once('error',error=>{console.error(error.message);process.exitCode=1;});
