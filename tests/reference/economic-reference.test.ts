import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createEconomicScenario,advanceEconomicScenario,type EconomicOutpost,type EconomicSetup} from '../../packages/engine/src/index.js';
const adapter=await import(new URL('../../../scripts/reference-functions.mjs',import.meta.url).href);
test('integrated economics agrees with original p3e at every tick across start-speed and capacity boundaries',()=>{
  const reference=adapter.readReference();
  const typeNumber={factory:1,generator:2,mine:0};
  let comparisons=0;
  for(const initialTick of [0,70,72,100])for(const drillers of [0,148,160]){
    const mk=(id:string,owner:number|null,patch:Partial<EconomicOutpost>={}):EconomicOutpost=>({id,owner,type:'factory',drillers:0,shield:0,shieldMax:10,shieldsEnabled:true,productionProgress:47,miningProgress:0,shieldProgress:27,minePending:false,shieldDisablePending:false,...patch});
    const setup:EconomicSetup={initialTick,teamSize:0,players:[{active:true,neptunium:0,minesCreated:1},{active:false,neptunium:0,minesCreated:1}],
      outposts:[mk('a',0,{drillers}),mk('b',0),mk('m',0,{type:'mine',miningProgress:47.9}),mk('off',1,{type:'mine',miningProgress:143}),mk('neutral',null)]};
    const expected=adapter.runReferenceEconomy(reference,setup,160);
    let actual=createEconomicScenario(setup);
    for(let index=0;index<expected.length;index++){
      actual=advanceEconomicScenario(actual,actual.tick+1);
      assert.deepEqual({tick:actual.tick,players:actual.players.map(p=>({neptunium:p.neptunium,minesCreated:p.minesCreated})),
        outposts:actual.outposts.map(o=>({type:typeNumber[o.type],drillers:o.drillers,shield:o.shield,
          productionProgress:o.productionProgress,miningProgress:o.miningProgress,shieldProgress:o.shieldProgress}))},expected[index],`initial=${initialTick},drillers=${drillers},tick=${actual.tick}`);
      comparisons++;
    }
  }
  assert.equal(comparisons,1920);
});
