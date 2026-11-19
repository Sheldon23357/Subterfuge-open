/** Disposable development game. Never imported by the normal game entrypoints. */
import {readFile,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createFleetScenario,type FleetSetup} from '../../engine/src/index.js';
import {PlayerAccess} from './player-access.js';
import {createGameOnlyServer} from './game-server.js';
import {servePlayerStatic} from './player-static.js';
import type {LabRoom} from './planning.js';

const directory=process.env.SUBTERFUGE_DEMO_DIRECTORY;
if(!process.send||!directory||!basename(directory).startsWith('subterfuge-agent-demo-')||await readFile(join(directory,'demo.marker'),'utf8')!=='synthetic-agent-demo/1')throw Error('Use npm run demo:agent to start this disposable game');
const setup=JSON.parse(await readFile('examples/fleet-lab.json','utf8')).initial as FleetSetup;
setup.size={width:80,height:80};setup.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:20,y:0},'红方后方':{x:25,y:0}};
let room:LabRoom={state:createFleetScenario(setup),scheduled:[]};
const credentials=PlayerAccess.generate(2);
room={...room,playerRoomId:credentials.roomId};
const game=await createGameOnlyServer({store:join(directory,'synthetic-game.sqlite'),access:credentials,initialRoom:room,legacyChat:join(directory,'synthetic-chat.json'),clock:'manual'});
let origin='',consoleURL='';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const server=createServer(async(req,res)=>{
 if(req.headers.host!==new URL(origin).host||req.headers.origin!==undefined&&req.headers.origin!==origin){res.writeHead(403).end();return;}
 const path=new URL(req.url??'/',origin);
 if(path.pathname==='/demo'){
  if(req.method!=='GET'||path.search||req.headers['sec-fetch-site']&&!['same-origin','none'].includes(String(req.headers['sec-fetch-site']))){res.writeHead(403).end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
  res.end(`<!doctype html><meta charset="utf-8"><title>合成测试 · 独立 AI</title><style>body{font:16px system-ui;max-width:850px;margin:40px auto;padding:20px;background:#071523;color:#dbeafe}a{color:#7dd3fc}textarea{width:100%;height:3em}section{margin:24px 0;padding:20px;border:1px solid #37516a}code{overflow-wrap:anywhere}</style><h1>独立 AI：一次性合成测试</h1><p>仅此临时测试局有效。不是生产账号或真实玩家授权。关闭启动器后全部销毁。</p><p>固定 8 个 AI 席位、未绑定、offline provider；启动后使用真实席位控制，不调用付费模型。此小型固定测试局不自动推进。</p><p><a href="/" target="_blank" rel="noreferrer">打开测试游戏</a> · <a href="${escape(consoleURL)}" target="_blank" rel="noreferrer">打开独立 AI Console</a></p><p>控制器预置八个未绑定席位，可检查配置界面；合成游戏登录使用以下任一测试席位凭据。完整开局绑定请使用本地实验室的新航行页面。先选择文本再复制。</p><label>游戏地址<textarea readonly>${escape(origin)}</textarea></label><p>房间：<code>${escape(credentials.roomId)}</code></p>${credentials.credentials.map(c=>`<section><h2>合成席位 ${c.player+1}</h2><label>仅测试用玩家凭据<textarea readonly aria-label="合成席位 ${c.player+1} 凭据">${c.token}</textarea></label></section>`).join('')}`);return;
 }
 if(path.pathname==='/'&&req.method==='GET'&&await servePlayerStatic('packages/client/public',req,res))return;
 game.server.emit('request',req,res);
});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('Missing demo listener');origin=`http://127.0.0.1:${address.port}`;
process.send({kind:'ready',url:origin});
let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await game.close();if(!process.connected&&!consoleURL)await rm(directory!,{recursive:true,force:true});if(process.connected)process.disconnect();}
process.on('message',raw=>{const message=raw as {kind?:string;url?:string};if(message.kind==='console'&&message.url){const url=new URL(message.url);if(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.pathname==='/'&&!url.search&&!url.hash){consoleURL=url.href;process.send?.({kind:'configured'});}}if(message.kind==='stop')void close();});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void close());
process.once('disconnect',()=>void close());
