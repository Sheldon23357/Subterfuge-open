import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';

test('Optional SDK packs and runs with complete declarations in a clean consumer outside the repository',t=>{
  const root=process.cwd(),directory=mkdtempSync(join(tmpdir(),'player-sdk-consumer-')),artifact=join(directory,'package'),consumer=join(directory,'consumer');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const npmCli=process.env.npm_execpath??(process.platform==='win32'?join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'):undefined);
  const run=(command:string,args:string[],cwd=root)=>{
    if(command==='npm'&&npmCli){command=process.execPath;args=[npmCli,...args];}
    const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:120000,env:{...process.env,npm_config_cache:join(directory,'npm-cache')}});
    assert.equal(result.status,0,result.stdout+result.stderr+String(result.error??''));return result.stdout;
  };
  run(process.execPath,['scripts/build-player-sdk.mjs','--out',artifact]);
  const manifest=JSON.parse(readFileSync(join(artifact,'package.json'),'utf8'));assert.equal(manifest.exports['.'].import,'./dist/index.js');assert.equal(manifest.dependencies,undefined);assert.equal(manifest.private,undefined);
  const inputs=JSON.parse(readFileSync(join(artifact,'dist/bundle-inputs.json'),'utf8')) as string[];assert.ok(inputs.every(file=>/^packages\/(player-sdk|contracts)\/src\//.test(file)));assert.ok(!inputs.some(file=>/engine|prediction|\/ai\//.test(file)));
  run('npm',['pack',artifact,'--pack-destination',directory,'--ignore-scripts']);const tarball=readdirSync(directory).find(name=>name.endsWith('.tgz'))!;assert.ok(tarball);
  mkdirSync(consumer);writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'independent-sdk-consumer',version:'0.0.0',private:true,type:'module'}));
  run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',join(directory,tarball)],consumer);
  assert.equal(manifest.license,'MIT');
  assert.deepEqual(readFileSync(join(consumer,'node_modules/@subterfuge/player-sdk/LICENSE')),readFileSync(join(root,'LICENSE')));
  const source=`import {PlayerProtocolClient, MemoryProtocolClientStore, type ProtocolClientStore, type CommandIntent, type ProtocolScope, type ProtocolCheckpointStatus} from '@subterfuge/player-sdk';\nconst scope:ProtocolScope={serverId:'test',roomId:'test',roomEpoch:'test',playerId:'opaque-subject'};\nconst store:ProtocolClientStore=new MemoryProtocolClientStore();\nconst client=new PlayerProtocolClient({serverUrl:'http://127.0.0.1:1',token:'synthetic',store,expectedIdentity:{roomId:'test',gamePlayer:0}});\nconst command:CommandIntent={idempotencyKey:'test',clientCommandId:'test',expectedRevision:'0'.repeat(64),instructionsVersion:'0',kind:'order',payload:{action:{kind:'check-in'}}};\nconst checkpoint:ProtocolCheckpointStatus|null=null;\nif(typeof client.checkpointCurrent!=='function'||typeof client.checkpointAck!=='function')throw Error('Missing checkpoint API');\nif(client.writable||command.kind!=='order')throw Error('Unexpected default');\nconsole.log('independent package loaded paused');\n`;
  writeFileSync(join(consumer,'index.ts'),source);
  run(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--strict','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--outDir',join(consumer,'compiled'),join(consumer,'index.ts')],consumer);
  assert.match(run(process.execPath,[join(consumer,'compiled/index.js')],consumer),/loaded paused/);
  assert.ok(!readFileSync(join(artifact,'dist/index.js'),'utf8').includes(resolve(root,'packages/ai')));
});
