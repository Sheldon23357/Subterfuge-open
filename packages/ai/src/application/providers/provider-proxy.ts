import * as http from 'node:http';
let configured='';
/** Enable Node's environment proxy for model traffic, preserving local game I/O. */
export function configureProviderProxy(env:NodeJS.ProcessEnv=process.env){
 const https=env.https_proxy??env.HTTPS_PROXY,httpProxy=env.http_proxy??env.HTTP_PROXY;
 if(!https&&!httpProxy)return;
 const noProxy=[env.NO_PROXY,env.no_proxy,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');
 const key=JSON.stringify([https,httpProxy,noProxy]);if(key===configured)return;
 const configure=(http as unknown as {setGlobalProxyFromEnv?:(env:NodeJS.ProcessEnv)=>unknown}).setGlobalProxyFromEnv;
 if(!configure)throw Error('Model environment proxy requires Node.js 24.14 or later');
 configure({...env,NO_PROXY:noProxy,no_proxy:noProxy});configured=key;
}
