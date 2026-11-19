// Install transaction-local diagnostic anchors in an existing development DB.
// No tick advancement, orders, AI changes, or service restart.
import { access, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { RoomStore } from '../dist/packages/server/src/room-store.js';
const path=resolve(process.argv[2]??'runtime/subterfuge.sqlite');
await access(path);
const backupDirectory=join(dirname(path),'tick-time-backups');
await mkdir(backupDirectory,{recursive:true});
const backupPath=join(backupDirectory,`before-${new Date().toISOString().replace(/[^0-9]/g,'')}.sqlite`);
const original=new RoomStore(path,{readOnly:true});
try{await original.backup(backupPath);}finally{original.close();}
const store=new RoomStore(path);
try{
  let observed=false;
  for(let attempt=0;attempt<3;attempt++){
    const head=store.tickTimes();
    try{store.observeTick(head.revision);observed=true;break;}
    catch(error){if(!String(error?.message).includes('Stale room storage revision'))throw error;}
  }
  if(!observed)throw Error('Room is changing too quickly; retry baseline observation');
  const page=store.tickTimes(0,5000);
  console.log(JSON.stringify({enabled:true,path,backupPath,roomId:page.roomId,headTick:page.headTick,anchors:page.records.length,baseline:page.records.at(-1),mechanism:'SQLite transaction trigger; existing server stays running'},null,2));
}finally{store.close();}
