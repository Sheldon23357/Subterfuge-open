import {aiBoundaryViolation} from './ai-boundaries.mjs';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const dependencies = { rules: [], engine: ['rules'], contracts: ['rules'], prediction: ['rules','engine','contracts'], server: ['rules','engine','contracts','ai','prediction'], ai: ['rules','contracts','prediction','player-sdk'], 'player-sdk': ['contracts'], 'bot-sdk':['ai','contracts','prediction','rules'], client: ['rules','contracts','prediction'], tools: ['rules','engine','contracts'] };
const failures = [];
const sdkExports=fs.existsSync('packages/bot-sdk/exports.json')?JSON.parse(fs.readFileSync('packages/bot-sdk/exports.json','utf8')):{};
const sdkTargets=new Set(Object.values(sdkExports));
function inspect(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) inspect(file);
    else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const origin = file.split(path.sep)[1];
      const source = ts.createSourceFile(file, fs.readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        let spec;
        if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))spec=node.argument.literal;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
          spec = node.arguments[0];
          if ((!spec || !ts.isStringLiteral(spec)) && file.split(path.sep).join('/')!=='packages/ai/src/application/plugin-catalog.ts') failures.push(`${file}: computed imports forbidden`);
        }
        if (spec && ts.isStringLiteral(spec)) {
          const target = spec.text;
          const normalized=file.split(path.sep).join('/');
          if(normalized.startsWith('examples/ai-extension/')){
            const resolved=target.startsWith('.')?path.relative(process.cwd(),path.resolve(path.dirname(file),target)).split(path.sep).join('/'):target;
            const publicEntries=['packages/ai/src/extension.js','plugins/hybrid/src/api.js','packages/contracts/src/index.js'];
            if(path.basename(file)==='main.ts')publicEntries.push('packages/ai/src/runtime.js','packages/ai/src/providers.js');
            if(!(resolved.startsWith('examples/ai-extension/')||publicEntries.includes(resolved)||path.basename(file)==='main.ts'&&target.startsWith('node:')))failures.push(`${file}: extensions must use public source entries: ${target}`);
            ts.forEachChild(node,visit);return;
          }
          const typeOnly=ts.isImportTypeNode(node)?true:ts.isImportDeclaration(node)
            ?!!node.importClause&&(node.importClause.isTypeOnly||!node.importClause.name&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.length>0&&node.importClause.namedBindings.elements.every(e=>e.isTypeOnly))
            :ts.isExportDeclaration(node)&&node.isTypeOnly;
          const aiViolation=aiBoundaryViolation(file,target,typeOnly);
          if(aiViolation)failures.push(`${file}: ${aiViolation}: ${target}`);
          if(normalized==='packages/ai/src/application/plugin-catalog.ts'&&target==='../../../bot-sdk/exports.json'){ts.forEachChild(node,visit);return;}
          if(normalized==='packages/ai/src/reference.ts'&&target.endsWith('/plugins/hybrid/src/index.js')){ts.forEachChild(node,visit);return;}
          if(normalized.startsWith('packages/bot-sdk/src/')){
            const resolved=target.startsWith('.')?path.relative(process.cwd(),path.resolve(path.dirname(file),target)).split(path.sep).join('/'):target;
            if(!sdkTargets.has(resolved))failures.push(`${file}: SDK facade must export a declared host service: ${target}`);
            ts.forEachChild(node,visit);return;
          }
          if (target.startsWith('.')) {
            const resolved = path.relative(process.cwd(), path.resolve(path.dirname(file), target)).split(path.sep);
            if (resolved[0] === 'packages' && resolved[1] !== origin) {
              if (!dependencies[origin]?.includes(resolved[1])) failures.push(`${file}: forbidden dependency on ${resolved[1]}`);
              const entry=resolved.slice(2).join('/');
              const protocolEntry=origin==='player-sdk'&&resolved[1]==='contracts'&&entry==='src/protocol-index.js';
              const referenceEntry=origin==='engine'&&/^original-.*\.generated\.ts$/.test(path.basename(file))&&resolved[1]==='rules'&&['src/reference.js','src/reference-profile.js'].includes(entry);
              if (entry !== 'src/index.js'&&!protocolEntry&&!referenceEntry) failures.push(`${file}: import must use public index`);
              if(origin==='player-sdk'&&resolved[1]==='contracts'&&!protocolEntry) failures.push(`${file}: player SDK must use the dedicated public protocol index`);
            } else if (resolved[0] !== 'packages' && !(origin === 'rules' && resolved.slice(0,3).join('/') === 'docs/rules/data')) failures.push(`${file}: external file import ${target}`);
          } else if (['rules','engine','contracts'].includes(origin)) failures.push(`${file}: platform dependency ${target}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
}
inspect('packages');
if(fs.existsSync('examples/ai-extension'))inspect('examples/ai-extension');

for(const name of fs.existsSync('plugins')?fs.readdirSync('plugins'):[]){const folder=path.resolve('plugins',name);if(!fs.statSync(folder).isDirectory())continue;for(const file of fs.readdirSync(path.join(folder,'src')).filter(f=>f.endsWith('.ts'))){const full=path.join(folder,'src',file),source=ts.createSourceFile(full,fs.readFileSync(full,'utf8'),ts.ScriptTarget.Latest,true);function visit(node){let spec;if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))spec=node.moduleSpecifier;if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))spec=node.argument.literal;if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)spec=node.arguments[0];if(spec&&ts.isStringLiteral(spec)){const target=spec.text;const inside=target.startsWith('.')&&!path.relative(folder,path.resolve(path.dirname(full),target)).startsWith('..');const sdk=target==='@subterfuge/bot-sdk'||target.startsWith('@subterfuge/bot-sdk/')&&Object.hasOwn(sdkExports,target.replace('@subterfuge/bot-sdk/',''));if(!inside&&!sdk&&!target.startsWith('node:'))failures.push(full+': plugin must use its own modules or the public SDK: '+target);}ts.forEachChild(node,visit);}visit(source);}}

if (failures.length) {console.error(failures.join('\n'));process.exit(1);}
console.log('Module boundaries verified.');
