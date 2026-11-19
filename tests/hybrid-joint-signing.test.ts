import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {jointSigningAssessment} from '../plugins/hybrid/src/joint-signing.js';
import type {hybridPlanning} from '../plugins/hybrid/src/planning.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.economy.players.push({active:true,neptunium:0,minesCreated:0});
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'signing');
 const target=o.view.outposts.find(p=>p.owner===1)!;target.visibility=2;target.drillers=30;target.shield=10;target.type='mine';
 const source=o.view.outposts.find(p=>p.owner===0)!;source.drillers=100;
 const candidate={target:target.id,owner:1,classification:'action',score:1,attackWorldDays:10,additionalForceEstimate:0,assessment:{conclusion:'通过初筛',reasons:[] as string[]},newForceForScreenedAttackEstimate:41,launchSources:[{source:source.id,availableEstimate:100,travelWorldDays:10}],reasons:[]};
 const planning={basisRevision:o.revision,worldDay:o.view.tick,candidates:[candidate],coverage:{ranked:1,listed:1,opponentCandidates:1},excluded:[],estimates:{forceSources:{columns:[],rows:[],coverage:{listed:0,total:0}}},interpretation:''} as ReturnType<typeof hybridPlanning>;
 return {o,target,source,planning,candidate,assess:(hard:{forbiddenPlayers?:number[];forbiddenTargets?:string[];protectedSources?:string[];reserves?:{source:string;drillers:number}[]}={})=>jointSigningAssessment(o,planning,[2],hard)[0]!};
}
test('capture signing assessment provides facts without damage quotas or assumed allied execution',()=>{
 const f=fixture(),a=f.assess();assert.equal(a.enemy,1);assert.equal(a.captureGoal,1);assert.equal(a.peerExecution,'unknown');
 assert.equal(a.assessment,'conditional-support');assert.equal('recommendedCommitment' in a,false);
 f.candidate.attackWorldDays=200;assert.equal(f.assess().candidates[0]!.withinContractWindow,false);
 f.candidate.additionalForceEstimate=1;assert.equal(f.assess().assessment,'conditions-unmet');
 f.planning.candidates=[];assert.equal(f.assess().assessment,'not-assessed');assert.equal(f.assess().captureGoal,1);
});

test('capture screening preserves source and attack constraints without a negotiation veto',()=>{
 const f=fixture();assert.equal(f.assess({forbiddenPlayers:[1]}).prohibited,true);
 assert.equal(f.assess({forbiddenTargets:[f.target.id]}).candidates[0]!.permitted,false);
 const protectedSource=f.assess({protectedSources:[f.source.id]});
 assert.equal(protectedSource.candidates[0]!.availableAfterKnownConstraintsEstimate,0);
 assert.equal(protectedSource.candidates[0]!.supportedByCurrentScreening,false);
 assert.equal(f.assess({reserves:[{source:f.source.id,drillers:80}]}).candidates[0]!.supportedByCurrentScreening,false);
 f.target.visibility=0;assert.equal(f.assess().candidates[0]!.supportedByCurrentScreening,false);
});
