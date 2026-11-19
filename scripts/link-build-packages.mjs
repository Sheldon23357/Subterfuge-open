/** Make compiled workspace packages resolvable without installing dependencies. */
import {mkdir,writeFile,symlink,readlink} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
for(const [name,directory,exports] of [
 ['bot-sdk','packages/bot-sdk',{'.':'./src/index.js','./*':'./src/*.js'}],
 ['hybrid','plugins/hybrid',{'.':'./src/api.js'}],
]){
 const target=resolve('dist',directory);await mkdir(target,{recursive:true});
 await writeFile(target+'/package.json',JSON.stringify({name:'@subterfuge/'+name,type:'module',exports}));
 const scope=resolve('dist/node_modules/@subterfuge');await mkdir(scope,{recursive:true});const link=scope+'/'+name;
 const windows=process.platform==='win32';
 try{await symlink(windows?target:relative(scope,target),link,windows?'junction':'dir');}
 catch(e){if(e.code!=='EEXIST'||resolve(scope,await readlink(link))!==target)throw e;}
}
