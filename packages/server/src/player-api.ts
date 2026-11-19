import {createServer} from 'node:http';
import {createPlayerProtocolApi,type PlayerProtocolHost} from './player-protocol-api.js';
import {servePlayerStatic} from './player-static.js';
export {observation} from './player-observation.js';

/** The player listener exposes the versioned v2 protocol and static client. */
interface Host {protocol?:PlayerProtocolHost;webRoot?:string;publicOrigin?:string;}
export function createPlayerApi(host:Host){
  const protocol=host.protocol?createPlayerProtocolApi(host.protocol):undefined;
  const server=createServer((req,res)=>{
    const url=req.url??'/';
    if(protocol&&url.startsWith('/player/v2/')){protocol.emit('request',req,res);return;}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const origin=req.headers.origin;
    if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`&&origin!==host.publicOrigin){res.writeHead(403).end(JSON.stringify({error:'Browser origin not enabled'}));return;}
    void (async()=>{
      if(host.webRoot&&await servePlayerStatic(host.webRoot,req,res))return;
      res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:'Not found'}));
    })().catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});
  });
  const close=server.close.bind(server);
  server.close=(callback?:(error?:Error)=>void)=>{protocol?.close();return close(callback);};
  server.maxConnections=256;server.requestTimeout=15_000;server.headersTimeout=10_000;
  return server;
}
