import {RoomStore} from '../dist/packages/server/src/room-store.js';
import {observation} from '../dist/packages/server/src/player-api.js';
import {attackRoutes} from '../dist/packages/prediction/src/index.js';
import {screenAttacks} from '../dist/packages/ai/src/controller/analysis/attack-screening.js';
import {loadAttackScreeningConfig} from '../dist/packages/ai/src/controller/analysis/attack-screening-config.js';

// Offline read-only inspection. Redirect stdout to retain a tuning comparison.
// node scripts/inspect-attack-candidates.mjs --seat 1 --config config/ai-attack-screening.example.json
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
  if(!['--seat','--database','--config'].includes(args[i])||!args[i+1]||Object.hasOwn(options,args[i]))throw Error('Use --seat 1..N [--database path] [--config path]');
  options[args[i]]=args[i+1];
}
const seat=Number(options['--seat']);
if(!Number.isSafeInteger(seat)||seat<1)throw Error('--seat is a one-based player number');
const store=new RoomStore(options['--database']??'runtime/subterfuge.sqlite',{readOnly:true});
try{
  const saved=store.load();if(!saved)throw Error('No active room');
  const room=saved.room;if(seat>room.state.economy.players.length)throw Error('Seat is outside current room');
  const obs=observation(room,seat-1,room.playerRoomId??'offline-inspection');
  const config=loadAttackScreeningConfig(options['--config']);
  console.log(JSON.stringify({seat,config,...screenAttacks(obs,attackRoutes(obs,config.limits),config)},null,2));
}finally{store.close();}
