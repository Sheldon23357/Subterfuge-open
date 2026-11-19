import test from 'node:test';
import assert from 'node:assert/strict';
import {botWeightedEvaluation,botWeightedActionAllowed} from '../packages/ai/src/controller/analysis/tactical-selection.js';
import type {BotEvaluation} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
const score=(utility:number,outcome:BotEvaluation['outcome']=0,crossingTick:number|null=null):BotEvaluation=>({utility,outcome,crossingTick,terminalCertainty:'conditional',components:{troops:utility},unknowns:[]});

test('selection weights ordinary 60 percent and pressure 40 percent against their own baselines',()=>{
 const base=score(100),pressureBase=score(50),ordinary=score(120.61),pressure=score(22.68);
 const gain=botWeightedEvaluation(ordinary,pressure).utility-botWeightedEvaluation(base,pressureBase).utility;
 assert.ok(Math.abs(gain-1.438)<1e-9);
 assert.equal(botWeightedActionAllowed(ordinary,base,pressure,pressureBase),true);
 assert.equal(botWeightedActionAllowed(ordinary,base,pressure,pressureBase,2),false);
});
test('one rule admits either ordinary gains or pressure gains without a defense exception',()=>{
 assert.equal(botWeightedActionAllowed(score(259.37),score(100),score(88.31),score(100)),true);
 assert.equal(botWeightedActionAllowed(score(100.35),score(100),score(104.79),score(100)),true);
 assert.equal(botWeightedActionAllowed(score(70),score(100),score(150),score(100)),true,'no separate ordinary-loss cap');
 assert.equal(botWeightedActionAllowed(score(110),score(100),score(80),score(100)),false);
});
test('gain threshold is strict and absent pressure scenarios reuse the ordinary score',()=>{
 assert.equal(botWeightedActionAllowed(score(101),score(100)),false);
 assert.equal(botWeightedActionAllowed(score(101.01),score(100)),true);
 assert.equal(botWeightedActionAllowed(score(99),score(100)),false);
 assert.equal(botWeightedEvaluation(score(25)).utility,25);
});
test('wealth cannot buy ordinary or pressure elimination, a lost win or earlier defeat',()=>{
 const base=score(100);
 assert.equal(botWeightedActionAllowed(score(10000,-2),base,score(10000),base),false);
 assert.equal(botWeightedActionAllowed(score(10000),base,score(10000,-1,10),base),false);
 assert.equal(botWeightedActionAllowed(score(10000),score(0,1,10),score(10000),base),false);
 assert.equal(botWeightedActionAllowed(score(10000,-1,10),score(0,-1,20)),false);
 assert.equal(botWeightedActionAllowed(score(10000,1,20),score(0,1,10)),false);
});
test('terminal improvements remain lexicographic instead of being priced in utility',()=>{
 assert.equal(botWeightedActionAllowed(score(1),score(10000,-2),score(1),score(10000,-2)),true);
 assert.equal(botWeightedActionAllowed(score(1,1,10),score(10000,1,20)),true);
});
test('weighted audit components retain the same unit and unknown evidence',()=>{
 const ordinary={...score(10),components:{troops:12,exposure:-2},unknowns:['fog']};
 const pressure={...score(5),components:{troops:9,exposure:-4},unknowns:['fog','arrival']};
 const result=botWeightedEvaluation(ordinary,pressure);
 assert.equal(result.utility,8);assert.ok(Math.abs(result.components.troops!-10.8)<1e-9);
 assert.deepEqual(result.unknowns,['fog','arrival']);
 assert.equal(ordinary.utility,10);
});
