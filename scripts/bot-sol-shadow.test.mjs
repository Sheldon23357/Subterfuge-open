import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {capture,makePrompt,compareActions} from './bot-sol-shadow.mjs';
test('capture requires same room, player and exact historical revision; newer observations cannot substitute',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE journal(id INTEGER,room TEXT,seat INTEGER,kind TEXT,payload TEXT)');
 const put=(id,kind,payload)=>db.prepare('insert into journal values(?,?,?,?,?)').run(id,'room',4,kind,JSON.stringify(payload));
 put(1,'wake-state',{observed:{roomId:'room',revision:'old',view:{player:4,tick:9}}});
 put(2,'wake-state',{observed:{roomId:'room',revision:'new',view:{player:4,tick:10}}});
 const row={id:3,payload:JSON.stringify({sequence:1,decision:{basisRevision:'old',observedTick:9,parameters:{},selected:{objective:'secret-current-bot-choice'}}})};
 try{const data=capture(db,'room',4,row);assert.equal(data.input.observation.revision,'old');assert.doesNotMatch(makePrompt(data.input),/secret-current-bot-choice/);assert.equal(data.input.provenance.exactObservation,true);
 assert.throws(()=>capture(db,'other-room',4,row),/unavailable/);assert.throws(()=>capture(db,'room',5,row),/unavailable/);
 assert.throws(()=>capture(db,'room',4,{id:3,payload:JSON.stringify({sequence:1,decision:{basisRevision:'missing'}})}),/unavailable/);
 }finally{db.close();}
});
test('comparison parses local proposals only and preserves no-action decisions',()=>{
 const bot={decision:{selected:{objective:'hold',drafts:[]}}};
 const sol={summary:'等待',actions:[],reasons:[],risks:[],checks:[]};
 assert.deepEqual(compareActions(bot,sol).sol.parsedActions,[]);
 assert.throws(()=>compareActions(bot,{...sol,actions:[{actionJson:'[]'}]}),/Invalid/);
});
