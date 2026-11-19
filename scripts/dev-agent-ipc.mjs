let serial=0;
export function waitForController(child,timeoutMs=30000){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error('AI controller readiness timed out'));},timeoutMs);
  const message=value=>{if(value?.kind==='dev-reload-ready'){cleanup();resolve();}};
  const exit=()=>{cleanup();reject(Error('AI controller exited before readiness'));};
  const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',exit);};
  child.on('message',message);child.once('exit',exit);child.once('error',exit);
 });
}
export function controllerRequest(child,kind,seats,timeoutMs=90000){
 return new Promise((resolve,reject)=>{
  const requestId=String(++serial);
  const timer=setTimeout(()=>{cleanup();reject(Error(`AI ${kind} timed out`));},timeoutMs);
  const message=value=>{
   if(value?.kind!=='dev-reload-result'||value.requestId!==requestId)return;
   cleanup();value.error?reject(Error(value.error)):resolve(value.result);
  };
  const exit=()=>{cleanup();reject(Error(`AI controller exited during ${kind}`));};
  const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);};
  child.on('message',message);child.once('exit',exit);
  if(!child.connected){cleanup();reject(Error('AI development IPC is not connected'));return;}
  child.send({kind,requestId,...seats?{seats}:{}},error=>{if(error){cleanup();reject(Error('AI development IPC send failed'));}});
 });
}
