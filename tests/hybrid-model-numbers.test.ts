import test from 'node:test';
import assert from 'node:assert/strict';
import {presentModelNumbers} from '../plugins/hybrid/src/model-numbers.js';

test('model distances retain supplied opening classification and order without mutating program geometry',()=>{
 const input={global:{opening:{columns:['id','zone','ownDistance','rivalDistance','covered'],rows:[['MARANGA','contested',3.5034310255740366,3.208744427533886,false],['NEAR','own-near',1.00049,1.00048,true]]}}};
 const before=structuredClone(input),p=presentModelNumbers(input);
 assert.deepEqual(input,before);
 assert.deepEqual(p.value.global.opening.rows,[['MARANGA','contested',3.503,3.209,false],['NEAR','own-near',1,1,true]],'classification and ordering remain producer decisions even if display values tie');
 assert.equal(p.changes[0]!.path,'global.opening[0].ownDistance');assert.deepEqual(p.changes[0]!.keys,['global','opening','rows',0,2]);
 assert.equal(p.changes[0]!.before,3.5034310255740366);assert.equal(p.changes[0]!.after,3.503);
});

test('known derived quantities use bounded display precision across both records and semantic table columns',()=>{
 const input={global:{players:{columns:['player','staticVictoryWorldDays'],rows:[[0,11.368421052631579]]},mining:{staticVictoryWorldDays:11.368421052631579},relations:{competition:[{score:0.45999999999999996}]},planning:{launchSourceColumns:['source','travelWorldDays'],candidates:{columns:['target','score','launchSources'],rows:[['E',9.123456,[['HOME',3.1234567]]]]},estimates:{forceSources:{columns:['source','availableEstimate'],rows:[['HOME',17.123456]]}}}},guidance:{diplomacyPurpose:{needs:[{evidence:{pressureRatio:2.725118483412322}}]},executionFeasibility:[{travelWorldDays:3.1234567,safeAvailableEstimate:17.123456}]},facts:{relevantFacts:[{outpost:{position:{x:-10.311325073242188,y:11.947857856750488}}}]}};
 const p=presentModelNumbers(input).value;
 assert.equal(p.global.players.rows[0]![1],11.368);assert.equal(p.global.mining.staticVictoryWorldDays,11.368);
 assert.equal(p.global.relations.competition[0]!.score,.46);
 assert.deepEqual(p.global.planning.candidates.rows,[['E',9.123,[['HOME',3.123]]]]);
 assert.deepEqual(p.global.planning.estimates.forceSources.rows,[['HOME',17.123]]);
 assert.equal(p.guidance.diplomacyPurpose.needs[0]!.evidence.pressureRatio,2.725);
 assert.deepEqual(p.guidance.executionFeasibility,[{travelWorldDays:3.123,safeAvailableEstimate:17.123}]);
 assert.deepEqual(p.facts.relevantFacts[0]!.outpost.position,{x:-10.311325073242188,y:11.947857856750488});
});

test('deadlines, current time, thresholds, receipts, constraints, prose and unknown numeric fields retain exact values',()=>{
 const n=19.999999999999996,input={global:{time:{worldDay:n},self:{drillers:5,neptunium:n},relations:{values:{columns:['trust','history'],rows:[[n,n]]}},future:{ownDistance:n,score:n},opening:{columns:['ownDistance','future'],rows:[[null,n]]}},guidance:{serverAgreements:{current:{jointAttack:{columns:['deadline','ownCaptureGoal','ownProgress'],rows:[[n,n,n]]}},history:{ceasefire:{columns:['endedAt'],rows:[[n]]}}},contractResults:{columns:['time','result'],rows:[[n,{before:n,after:n}]]},executionRules:{reserves:[{drillers:n}]},commander:{text:'保留19.999999999999996'},intentTasks:[{spec:{until:n,maxDrillersPerPlan:0}}]},evidence:{messages:[{text:String(n),tick:n}]},responseSchema:{maximum:n}};
 assert.deepEqual(presentModelNumbers(input).value,input);assert.deepEqual(presentModelNumbers(input).changes,[]);
});

test('tiny nonzero estimates keep sign and magnitude; null, zero, false, integer values and repeat formatting are stable',()=>{
 const input={global:{opening:[{ownDistance:0.000000123456,rivalDistance:-0.000000987654},{ownDistance:0,rivalDistance:null,covered:false},{ownDistance:12,rivalDistance:3.2}]}};
 const first=presentModelNumbers(input);
 assert.equal(first.value.global.opening[0]!.ownDistance,1.23e-7);assert.equal(first.value.global.opening[0]!.rivalDistance,-9.88e-7);
 assert.deepEqual(first.value.global.opening.slice(1),input.global.opening.slice(1));
 const second=presentModelNumbers(first.value);assert.deepEqual(second.value,first.value);assert.deepEqual(second.changes,[]);
});

test('commander planning arrays and nested source tables receive the same presentation without rounding authored task parameters',()=>{
 const input={planning:{candidates:[{score:2.123456,attackWorldDays:4.123456,launchSources:{columns:['source','travelWorldDays'],rows:[['HOME',4.123456]]}}]},intentTasks:[{spec:{until:10.123456,maxDrillersPerPlan:20}}],currentMessage:{text:'坐标4.123456'}};
 const p=presentModelNumbers(input).value;
 assert.equal(p.planning.candidates[0]!.score,2.123);assert.equal(p.planning.candidates[0]!.attackWorldDays,4.123);
 assert.deepEqual(p.planning.candidates[0]!.launchSources.rows,[['HOME',4.123]]);
 assert.deepEqual(p.intentTasks,input.intentTasks);assert.deepEqual(p.currentMessage,input.currentMessage);
});
