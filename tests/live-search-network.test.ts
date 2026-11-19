import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {BotSearchProgress,BotLiveSnapshot} from '../packages/contracts/src/index.js';
import {mergeSearchNetwork,searchNodePosition,placeSearchNodes,searchNetworkScene,searchNetworkSelection,searchNetworkEdges,searchConnectionPath} from '../packages/client/src/live-search-network.js';
import {searchActionDetails} from '../packages/client/src/live-search-details.js';
import {SearchNetwork} from '../packages/client/src/AgentLiveGraphics.js';
const branch=(id:string,status='evaluated'):BotSearchProgress['branches'][number]=>({id,status,kind:'attack',targets:[],utility:null,routes:[]});
const progress=(sequence:number,branches:BotSearchProgress['branches'])=>({sequence,progress:{basisRevision:'r',observedTick:50,elapsedMs:100,stage:'discovery',generated:100,evaluated:60,simulations:60,maximum:80,horizon:144,timeLimitMs:8000,stages:{},branches}});
const decision=(sequence:number,branches:BotSearchProgress['branches']):NonNullable<BotLiveSnapshot['decision']>=>({sequence,finalized:true,observedTick:50,current:true,selected:'b-0',kind:'attack',targets:[],reasons:[],coverage:{generated:100,evaluated:60,simulations:60,complete:true,stopReason:'complete'},parameters:{maxSimulations:80,maxElapsedMs:8000,horizonTicks:144},branches,drafts:[]});
test('all same-round nodes survive finalization; only statuses and final selection change',()=>{
 const first=Array.from({length:65},(_,i)=>branch('b-'+i));
 let frame=mergeSearchNetwork(undefined,'seat:g',progress(12,[...first,branch('unfinished','running')]),null,true);
 const original=structuredClone(frame);
 frame=mergeSearchNetwork(frame,'seat:g',undefined,decision(12,[branch('b-0'),branch('b-64','invalid'),branch('new-last')]),false);
 assert.equal(frame.branches.length,67);assert.equal(frame.selected,'b-0');assert.equal(frame.settled,true);
 assert.equal(frame.branches.find(b=>b.id==='unfinished')!.status,'interrupted');
 assert.equal(frame.branches.find(b=>b.id==='b-64')!.status,'invalid');
 assert.equal(original.branches.find(b=>b.id==='unfinished')!.status,'running');
 const html=renderToStaticMarkup(React.createElement(SearchNetwork,{branches:frame.branches,selected:frame.selected,names:{},active:false,stage:'已结束'}));
 assert.equal((html.match(/data-branch-id=/g)??[]).length,67);assert.ok(!html.includes('animateMotion'));assert.ok(html.includes('live-selected-branch'));
});
test('node coordinates survive growth, final-state changes and ordering',()=>{
 const nodes=[branch('one'),branch('two')];
 const render=(branches:typeof nodes)=>renderToStaticMarkup(React.createElement(SearchNetwork,{branches,selected:undefined,names:{},active:false,stage:'test'}));
 const coordinate=(html:string,id:string)=>html.split('data-branch-id="'+id+'"')[1]!.match(/<circle cx="([^"]+)" cy="([^"]+)"/)!.slice(1);
 assert.deepEqual(coordinate(render(nodes),'one'),coordinate(render([branch('three'),branch('two','invalid'),branch('one','evaluated')]),'one'));
 const p=searchNodePosition('one',{x:0,y:0,rx:60,ry:40});assert.ok(p.x*p.x/3600+p.y*p.y/1600<=1);
});
test('separated slots use the canvas width and preserve existing positions on new arrivals',()=>{
 const first=Array.from({length:40},(_,i)=>({...branch('node-'+i),kind:['attack','defense','economy','logistics','combined'][i%5]!}));
 const a=placeSearchNodes(first),before=new Map([...a].map(([id,p])=>[id,{...p}]));
 const b=placeSearchNodes([...first].reverse().concat(Array.from({length:40},(_,i)=>branch('node-'+(40+i)))),a);
 assert.equal(b.size,80);assert.deepEqual(a,before);
 for(const [id,p] of before)assert.deepEqual(b.get(id),p);
 const points=[...b.values()];assert.ok(Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))>.7);
 for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)assert.ok(Math.hypot(points[i]!.x-points[j]!.x,points[i]!.y-points[j]!.y)>.04);
});
test('late previous-round result cannot replace new search or appear in the handover gap',()=>{
 let frame=mergeSearchNetwork(undefined,'seat:g',progress(13,[branch('new','running')]),decision(12,[branch('old')]),true);
 frame=mergeSearchNetwork(frame,'seat:g',undefined,decision(12,[branch('old')]),false);
 assert.deepEqual(frame.branches.map(b=>b.id),['new']);assert.equal(frame.selected,undefined);assert.equal(frame.sequence,13);
 frame=mergeSearchNetwork(frame,'seat:g',undefined,{...decision(13,[branch('new')]),finalized:false},false);assert.equal(frame.selected,undefined);
 frame=mergeSearchNetwork(frame,'other:g',undefined,decision(2,[branch('other')]),false);assert.deepEqual(frame.branches.map(b=>b.id),['other']);
 frame=mergeSearchNetwork(frame,'other:g',progress(3,[branch('next')]),null,true);assert.deepEqual(frame.branches.map(b=>b.id),['next']);
});
test('positions group the same objective variants while keeping other strategies separate',()=>{
 const nodes=[{...branch('force-10'),targets:['port'],routes:[{source:'home',target:'port',drillers:10}]},{...branch('force-20'),targets:['port'],routes:[{source:'home',target:'port',drillers:20}]},{...branch('defend'),kind:'defense',targets:['other']}];
 const points=placeSearchNodes(nodes),a=points.get('force-10')!,b=points.get('force-20')!,c=points.get('defend')!;
 assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<.15);assert.ok(Math.hypot(a.x-c.x,a.y-c.y)>.15);
 const old=new Map(points);assert.deepEqual(placeSearchNodes([...nodes].reverse(),points),old);
});

test('hold is central and combinations highlight actual parts without extra graph nodes',()=>{
 const a={...branch('a','invalid'),utility:4},part={id:'b',kind:'fleet',targets:['port'],routes:[]};
 const combo={...branch('joint:a+b'),kind:'combined',utility:100,components:[a,part]};
 const hold={...branch('hold'),kind:'hold'};
 const scene=searchNetworkScene([a,combo,hold]);
 assert.deepEqual(scene.nodes.map(b=>b.id),['a','hold','b']);
 assert.equal(scene.nodes.find(b=>b.id==='a')!.status,'invalid');
 assert.deepEqual(scene.nodes.find(b=>b.id==='b'),{...part,status:'component',utility:null});
 assert.deepEqual(searchNetworkSelection(scene,combo.id),['a','b']);
 assert.deepEqual(searchNetworkSelection(scene,'hold'),['hold']);
 assert.deepEqual(placeSearchNodes(scene.nodes).get('hold'),{x:.5,y:.5});
 const html=renderToStaticMarkup(React.createElement(SearchNetwork,{branches:[a,combo,hold],selected:combo.id,names:{},active:false,stage:'已结束'}));
 assert.ok(!html.includes('data-branch-id="joint:a+b"'));assert.ok(html.includes('data-bundle-id="joint:a+b"'));
 assert.equal((html.match(/data-final-member="true"/g)??[]).length,2);
 assert.ok(!html.includes('live-flow-line'));assert.ok(!html.includes('animateMotion'));
 const {components,...legacyBranch}=combo;
 const legacy=searchNetworkScene([legacyBranch]);
 assert.equal(legacy.nodes.length,0);assert.deepEqual(searchNetworkSelection(legacy,combo.id),[]);
});

test('neural connections express only shared facts or actual combination membership, never hold dependencies',()=>{
 const nodes=[{...branch('a'),targets:['port']},{...branch('b'),targets:['port']},{...branch('c'),targets:['elsewhere']},{...branch('hold'),kind:'hold'}];
 const combo={...branch('joint'),kind:'combined',components:[nodes[0]!,nodes[2]!]};
 const scene=searchNetworkScene([...nodes,combo]),edges=searchNetworkEdges(scene,placeSearchNodes(scene.nodes));
 assert.equal(edges.length,2);
 assert.ok(edges.some(e=>e.a==='a'&&e.b==='b'&&e.relation==='target'));
 assert.ok(edges.some(e=>e.a==='a'&&e.b==='c'&&e.bundles.includes('joint')));
 assert.ok(edges.every(e=>e.a!=='hold'&&e.b!=='hold'));
 const props={branches:[{...nodes[0]!,status:'running'},nodes[1]!],selected:undefined,names:{},stage:'组合推演'};
 const running=renderToStaticMarkup(React.createElement(SearchNetwork,{...props,active:true}));
 const ended=renderToStaticMarkup(React.createElement(SearchNetwork,{...props,active:false}));
 assert.ok(running.includes('animateMotion')&&running.includes('live-neuron-discharge'));
 assert.ok(!ended.includes('animateMotion')&&!ended.includes('live-neuron-discharge'));
});

test('all action types retain concrete details without depending on launch routes',()=>{
 const mine={...branch('mine'),kind:'economy',targets:['port'],actions:[{issueTick:25,action:{kind:'toggle-mine',outpostId:'port'}}],reasons:['比较开矿投入']};
 const names={port:'远港',home:'晨星'};
 assert.match(searchActionDetails(mine,names)[0]!,/切换矿场 · 远港 · 计划第 25 日/);
 const html=renderToStaticMarkup(React.createElement(SearchNetwork,{branches:[mine],selected:'mine',names,active:false,stage:'已结束'}));
 assert.ok(html.includes('切换矿场 · 远港'));assert.ok(!html.includes('<title>'));
 assert.match(searchActionDetails({...mine,actions:[{issueTick:25,action:{kind:'set-shields',outpostId:'port',enabled:false}}]},names)[0]!,/关闭护盾 · 远港/);
 assert.match(searchActionDetails({...mine,actions:[{issueTick:25,action:{kind:'return-fleet',fleetId:'F1-12345678'}}]},names)[0]!,/返航 · 舰队 F1-12345678/);
 assert.match(searchActionDetails({...mine,actions:[{issueTick:25,action:{kind:'launch',source:'home',destination:'port',drillers:17}}]},names)[0]!,/晨星 → 远港 · 17 兵/);
 assert.match(searchActionDetails(branch('unknown'),names)[0]!,/未包含行动详情/);
 assert.ok(html.includes('live-network-legend'));
});

test('cubic links remain smooth, scale with the canvas and clear the central baseline',()=>{
 const a={x:.1,y:.5},b={x:.9,y:.5},path=searchConnectionPath(a,b,1000,400);
 assert.ok(path.startsWith('M100 200C')&&path.endsWith('900 200'));assert.ok(!/[QL]/.test(path));
 const p=path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number),scaled=searchConnectionPath(a,b,2000,800).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
 p.forEach((v,i)=>assert.ok(Math.abs(scaled[i]!-v*2)<.00001));
 const middleY=(p[1]!+3*p[3]!+3*p[5]!+p[7]!)/8;
 assert.ok(Math.abs(middleY-200)>68);
});
