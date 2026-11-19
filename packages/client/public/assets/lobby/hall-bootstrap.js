const sheet=document.getElementById('hall-stylesheet');
const shell=document.querySelector('.hall-loading-shell');
const message=document.querySelector('.hall-loading-message');
const retry=document.querySelector('.hall-loading-retry');
let timer;
retry?.addEventListener('click',()=>location.reload());
try{
 await Promise.race([
  (async()=>{
   if(!sheet.sheet)await new Promise((resolve,reject)=>{sheet.addEventListener('load',resolve,{once:true});sheet.addEventListener('error',()=>reject(Error('Stylesheet unavailable')),{once:true});});
   sheet.media='all';
   await import('/hall.js');
  })(),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Hall startup timed out')),30000);})
 ]);
}catch{
 if(shell?.isConnected){shell.dataset.state='error';shell.setAttribute('aria-busy','false');message.textContent='大厅加载失败，请重新加载';retry.hidden=false;}
}finally{clearTimeout(timer);}
