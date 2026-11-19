import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Execute the real component's effects with inert rendering. No browser, game
// connection or recurring timer is needed to observe its startup HTTP traffic.
const source=readFileSync('packages/client/src/AgentConsole.tsx','utf8');
const ast=ts.createSourceFile('AgentConsole.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const bindings:Record<string,unknown>={};
for(const statement of ast.statements){
 if(!ts.isImportDeclaration(statement))continue;
 const clause=statement.importClause;if(clause?.name)bindings[clause.name.text]=()=>null;
 if(clause?.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const name of clause.namedBindings.elements)bindings[name.name.text]=()=>null;
}
const component=ts.createPrinter().printFile(ts.factory.updateSourceFile(ast,ast.statements.filter(statement=>!ts.isImportDeclaration(statement))));
const executable=ts.transpileModule(component,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;

for(const mode of ['local','configured'] as const)for(const discoveryFails of mode==='local'?[false,true]:[false]){
 test(`console ${mode} initialization loads configuration and status once${discoveryFails?' after failed discovery':''}`,async()=>{
  const effects:(()=>void|(()=>void))[]=[],requests:string[]=[],timers:(()=>void)[]=[],exports:Record<string,()=>void>={};
  const controls:{onDetect:()=>void}[]=[];
  const context={...bindings,exports,AbortController,URL,location:{hash:''},document:{hidden:false},
   React:{createElement:(type:{name?:string},props:{onDetect:()=>void})=>{if(type?.name==='AgentConsoleConnectionControls')controls.push(props);return null;}},
   useRef:(value:unknown)=>({current:value}),
   useState:(value:unknown)=>[typeof value==='function'?value():value,()=>{}],
   useEffect:(effect:()=>void|(()=>void))=>effects.push(effect),
   seatBindingTarget:()=>null,consoleDetailTabs:()=>[],
   setTimeout:(callback:()=>void)=>{timers.push(callback);return timers.length;},clearTimeout:()=>{},
   fetch:async(path:string)=>{
    requests.push(path);
    if(path.endsWith('/bootstrap'))return {ok:true,json:async()=>({csrf:'synthetic',connectionMode:mode})};
    if(path.endsWith('/connections/local'))return {ok:!discoveryFails,status:503,json:async()=>({available:0,added:[]})};
    if(path.endsWith('/config'))return {ok:true,json:async()=>({seats:[],strategies:[]})};
    if(path.endsWith('/status'))return {ok:true,json:async()=>({seats:[],jobs:[]})};
    throw Error('Unexpected console request');
   },
  };
  runInNewContext(executable,context);
  exports.AgentConsole!();
  const cleanup=effects[0]!();
  try{
   for(let turn=0;turn<100&&timers.length===0;turn++)await Promise.resolve();
   assert.deepEqual(requests,['/api/agent/bootstrap',...(mode==='local'?['/api/agent/connections/local']:[]),'/api/agent/config','/api/agent/status']);
   assert.equal(timers.length,1,'ordinary status polling remains scheduled');
   if(mode==='local'){
    requests.length=0;controls[0]!.onDetect();
    for(let turn=0;turn<100;turn++)await Promise.resolve();
    assert.deepEqual(requests,['/api/agent/connections/local','/api/agent/config','/api/agent/status'],'manual discovery still refreshes the view once');
   }
  }finally{if(typeof cleanup==='function')cleanup();}
 });
}
