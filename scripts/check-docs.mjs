import fs from 'node:fs';
import path from 'node:path';

// Static documentation lint only: no network, builds, tests, models or game APIs.
const files=['README.md','AGENTS.md','packages/player-sdk/README.md'];
function walk(directory){
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=directory+'/'+entry.name;
  if(entry.isDirectory())walk(file);
  else if(entry.name.endsWith('.md'))files.push(file);
 }
}
for(const directory of ['docs','examples/player-devkit','examples/player-clients','protocol/player'])walk(directory);
const errors=[],seen=new Set(),headings=new Map();let links=0;
const virtual=new Set(['BUILD-MANIFEST.json','SHA256SUMS','runtime/agent-cli.mjs','runtime/protocol.mjs','sdk','web','licenses']);
const text=file=>fs.readFileSync(file,'utf8').replace(/```[\s\S]*?```/g,'');
const slug=value=>value.toLowerCase().replace(/[`*_]/g,'').replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s/g,'-');
function anchors(file){
 if(!headings.has(file)){
  const values=new Set(),counts=new Map();
  for(const row of text(file).matchAll(/^#{1,6}\s+(.+)$/gm)){
   const base=slug(row[1]),count=counts.get(base)??0;counts.set(base,count+1);values.add(count?base+'-'+count:base);
  }
  headings.set(file,values);
 }
 return headings.get(file);
}
for(const file of files){
 if(seen.has(file))continue;seen.add(file);
 const content=text(file);
 if((content.match(/^# /gm)?.length??0)!==1)errors.push(file+': expected one document title');
 if(/^#{1,6}\s+.*(?:20\d{2}-\d{2}-\d{2}|本轮验证|本次验证|历史验收|实施进度|变更日志)/m.test(content))errors.push(file+': replace chronological headings with current topic sections');
 for(const match of content.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)){
  const target=match[1].replace(/^<|>$/g,'');if(/^(?:https?:|mailto:|data:)/i.test(target))continue;
  const [raw,fragment]=target.split('#');let resolved=raw?path.resolve(path.dirname(file),decodeURIComponent(raw)):path.resolve(file);
  // These templates are copied to a distribution root. Check their documented
  // repository-backed targets there; named build outputs are generated files.
  if(!fs.existsSync(resolved)&&file.startsWith('examples/player-devkit/')){
   const relative=path.posix.normalize(raw);
   if(/^(?:docs|protocol|examples)\//.test(relative))resolved=path.resolve(relative);
   else if(virtual.has(relative)||[...virtual].some(v=>relative.startsWith(v+'/')))continue;
  }
  links++;
  if(!fs.existsSync(resolved)){errors.push(file+': missing '+target);continue;}
  if(fragment&&resolved.endsWith('.md')&&!anchors(resolved).has(decodeURIComponent(fragment)))errors.push(file+': missing anchor '+target);
 }
}
const inventory=JSON.parse(fs.readFileSync('protocol/player/v2/conformance.json','utf8'));
for(const row of inventory.cases){
 if(Object.hasOwn(row,'status'))errors.push('conformance '+row.id+': execution status belongs in run reports');
 for(const source of row.tests??[])if(!fs.existsSync(source.testFile))errors.push('conformance '+row.id+': missing '+source.testFile);
}
if(errors.length){for(const error of errors)process.stderr.write(error+'\n');process.exitCode=1;}
else console.log(`Documentation verified: ${seen.size} Markdown files, ${links} local links, ${inventory.cases.length} conformance requirements.`);
