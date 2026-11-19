/** Read-only inventory for cleanup; no server imports, migrations or database writes. */
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export function listLocalGames(projectRoot) {
  const root=realpathSync(projectRoot),games=[],errors=[];
  const excluded=/^(?:checkpoints|match-archives|trash|outputs|node_modules|dist|\.venv|\.git|\.cleanup|offline-backup|game-before-.*|invalid-.*|archive-.*|.*-backup|.*-before-.*)$/i;
  const evidence=[];
  const runtime=join(root,'runtime');
  if(existsSync(runtime))for(const file of readdirSync(runtime,{withFileTypes:true})) {
    if(!file.isFile()||!file.name.endsWith('.json'))continue;
    try {const value=JSON.parse(readFileSync(join(runtime,file.name),'utf8').replace(/^\uFEFF/,''));if(value.roomId&&value.at&&Number.isFinite(Date.parse(value.at)))evidence.push({roomId:value.roomId,at:value.at});}catch{}
  }
  function walk(directory) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isSymbolicLink())continue; // Cleanup unlinks links without traversing their targets.
      if(entry.isDirectory()&&!excluded.test(entry.name))walk(path);
      if(entry.isFile()&&entry.name==='subterfuge.sqlite') {
        let db;
        try {
          db=new DatabaseSync(path,{readOnly:true});
          db.exec('BEGIN');
          const row=db.prepare("SELECT a.room_id, json_extract(s.payload,'$.playerRoomId') player_room_id, json_extract(s.payload,'$.snapshot') snapshot FROM active_room a JOIN snapshots s USING(room_id) WHERE slot=1").get();
          if(!row)throw Error('没有活动对局');
          const snapshot=JSON.parse(row.snapshot),roomId=row.player_room_id??row.room_id;
          if(typeof roomId!=='string'||!roomId||!Number.isSafeInteger(snapshot.expected?.economy?.tick)||snapshot.expected.economy.tick<0)throw Error('对局身份或 tick 无法核验');
          let anchor=0;
          if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tick_time_anchors'").get())anchor=Number(db.prepare('SELECT max(wall_ms) wall FROM tick_time_anchors WHERE room_id=?').get(row.room_id).wall??0);
          let createdAt=null;
          const metadata=join(directory,'room-created.json');
          if(existsSync(metadata)){const value=JSON.parse(readFileSync(metadata,'utf8').replace(/^\uFEFF/,''));if(value.roomId===roomId&&Number.isFinite(Date.parse(value.at)))createdAt=value.at;}
          const records=evidence.filter(e=>e.roomId===roomId);
          const lastActivityMs=Math.max(anchor,Date.parse(createdAt??'')||0,...records.map(e=>Date.parse(e.at)));
          // A split game/agent layout is one unit: never discard its sibling private store.
          const split=basename(directory)==='game'&&existsSync(join(dirname(directory),'agent'));
          const keepDirectory=split?dirname(directory):directory;
          const sharedRoot=['runtime','runtime-lobby','runtime-rooms'].some(name=>directory===join(root,name));
          const sharedState=/^(?:(?:subterfuge|lab-ai)\.sqlite(?:-wal|-shm)?|player-access\.json|controller-bindings\.json|ai-controller-slots\.json|commander-chat\.json|browser-(?:eight|lab)(?:-chat)?\.json|player-chat-[0-9a-f]{64}\.json|timeline-rewind\.json|checkpoint-(?:restored|request|response)\.json|independent-agent|checkpoints)$/;
          const protectedDirectories=sharedRoot?readdirSync(directory).filter(name=>sharedState.test(name)).map(name=>join(directory,name)):split?[directory,join(dirname(directory),'agent')]:[directory];
          games.push({directory,keepDirectory,protectedDirectories,database:path,roomId,tick:snapshot.expected?.economy?.tick??null,createdAt,lastActivity:lastActivityMs?new Date(lastActivityMs).toISOString():null,lastActivityMs,relative:relative(root,directory)});
        }catch(error){errors.push({path,error:error.message});}
        finally{if(db){try{db.exec('ROLLBACK');}catch{}db.close();}}
      }
    }
  }
  for(const name of ['runtime','runtime-lobby','runtime-rooms']){const path=join(root,name);if(existsSync(path)){if(lstatSync(path).isSymbolicLink())errors.push({path,error:'运行根目录是链接'});else walk(path);}}
  games.sort((a,b)=>b.lastActivityMs-a.lastActivityMs||a.relative.localeCompare(b.relative));
  return {games,errors};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.includes('--help'))console.log('用法：node scripts/list-local-games.mjs [项目根目录]\n只读列出对局，以数据库时间锚点和同房间运行记录排序；不以文件修改时间判断最新对局。');
  else console.log(JSON.stringify(listLocalGames(process.argv[2]??resolve(dirname(fileURLToPath(import.meta.url)),'..'))));
}
