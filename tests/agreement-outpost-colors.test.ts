import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ServerAgreements} from '../packages/client/src/ServerAgreements.js';
import {colors} from '../packages/client/src/theme.js';
import {createDiplomacyState,submitDiplomacy,projectDiplomacy,type DiplomacyWorld} from '../packages/engine/src/diplomacy.js';

test('agreement outpost names follow current authorized ownership, including transfers and unknown owners',()=>{
 const world:DiplomacyWorld={size:{width:40,height:40},ended:false,
  players:Array.from({length:3},()=>({active:true,neptunium:100,drillers:100})),
  outposts:['a','b','c','d'].map((id,i)=>({id,owner:i%2,destroyed:false,type:'generator',position:{x:i,y:0}}))};
 const {state,world:w}=submitDiplomacy(createDiplomacyState(3,0),world,0,'truce',{
  kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['a','b','c','d']},subsidy:null,counterTo:null,
 },0);
 const value=projectDiplomacy(state,w,0),names={a:'ALPHA',b:'BETA',c:'NEUTRAL',d:'UNKNOWN'};
 const render=(owner:number)=>renderToStaticMarkup(React.createElement(ServerAgreements,{
  value,names,outposts:[{id:'a',owner},{id:'b',owner:1},{id:'c',owner:null}],
 }));
 assert.ok(render(0).includes(`<span style="color:${colors[0]}">ALPHA</span>`));
 const transferred=render(2);
 assert.ok(transferred.includes(`<span style="color:${colors[2]}">ALPHA</span>`));
 assert.ok(transferred.includes(`<span style="color:${colors[1]}">BETA</span>`));
 assert.ok(transferred.includes('<span>NEUTRAL</span>'));
 assert.ok(transferred.includes('<span>UNKNOWN</span>'));
});
