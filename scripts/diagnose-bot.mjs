/** Read-only diagnosis of an isolated saved game, always through seat visibility.
 * node scripts/diagnose-bot.mjs ROOM_JSON SEAT OUTPUT_JSON [SIMULATIONS] [MS]
 * Does not submit orders, advance the authoritative room or contact a model. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {restoreRoom} from '../dist/packages/server/src/planning.js';
import {observation} from '../dist/packages/server/src/player-api.js';
import {attackRoutes} from '../dist/packages/prediction/src/index.js';
import {planBot} from '../dist/packages/ai/src/controller/local/bot-planner.js';
const [source,seatText,output,simulations='96',milliseconds='10000',...extra]=process.argv.slice(2);
if(!source||seatText===undefined||!output||extra.length)throw Error('Expected ROOM_JSON SEAT OUTPUT_JSON [SIMULATIONS] [MS]');
if(resolve(source)===resolve(output))throw Error('Diagnosis cannot overwrite its source');
const seat=Number(seatText),raw=readFileSync(source,'utf8'),room=restoreRoom(raw);
if(!Number.isSafeInteger(seat)||seat<0||seat>=room.state.economy.players.length)throw Error('Invalid seat');
const observed=observation(room,seat,'isolated-bot-diagnosis');
const decision=planBot(observed,attackRoutes(observed,{attackTicks:144,localTicks:144,holdTicks:24}),{maxSimulations:Number(simulations),maxElapsedMs:Number(milliseconds)});
const statuses={};
for(const a of decision.assessments)statuses[a.status]=(statuses[a.status]??0)+1;
const report={format:'bot-diagnosis/1',sourceDigest:createHash('sha256').update(raw).digest('hex'),seat,tick:observed.view.tick,observed,decision,statuses,
  limitations:['Current facts only; original incumbent objective and scout history are not restored','Finite search; scored alternatives are conditional, not an assertion of enemy intent']};
mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,seat,tick:report.tick,selected:decision.selected.objective,coverage:decision.coverage,statuses}));
