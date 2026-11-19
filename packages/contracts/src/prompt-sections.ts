/** Internal model-input framing shared by prompt producers and the console.
 * Lengths and offsets use UTF-16 code units, exactly like saved prompt.length. */
import {MODEL_DATA_PREFIX,readPromptSectionData} from './model-data.js';
export interface PromptSection {id:string;label:string;format:'text'|'json'|'compact';text:string}
export interface SavedPromptSection extends PromptSection {start:number;bodyStart:number;bodyEnd:number;end:number}
const sectionId=/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export function encodePromptSections(sections:readonly PromptSection[]):string {
 const ids=new Set<string>();
 return sections.map(section=>{
  if(ids.has(section.id))throw Error('Duplicate prompt section: '+section.id);
  ids.add(section.id);
  const {id,label,text}=section;
  if(!sectionId.test(id)||!label||/[\]\r\n]/.test(label))throw Error('Invalid prompt section name');
  // Names alone reach the model. A wider bracket fence avoids collisions with
  // authored closing markers without rewriting any body text.
  let width=1;
  while(('\n'+text+'\n').includes('\n'+'['.repeat(width)+'/'+id+']'.repeat(width)+'\n'))width++;
  const left='['.repeat(width),right=']'.repeat(width);
  return left+id+' '+label+right+'\n'+text+'\n'+left+'/'+id+right+'\n';
 }).join('');
}
/** Parse only a complete framed document. Never scan user prose for boundaries. */
export function readPromptSections(text:string):SavedPromptSection[]|null {
 const sections:SavedPromptSection[]=[],ids=new Set<string>();let cursor=0;
 while(cursor<text.length){
  const newline=text.indexOf('\n',cursor);
  if(newline<0)return null;
  const header=/^(\[+)([a-zA-Z0-9][a-zA-Z0-9._-]*) ([^\]\r\n]+)(\]+)$/.exec(text.slice(cursor,newline));
  if(!header)return null;
  const left=header[1]!,id=header[2]!,label=header[3]!,right=header[4]!;
  if(left.length!==right.length||ids.has(id))return null;
  const suffix='\n'+left+'/'+id+right+'\n';
  const bodyStart=newline+1,bodyEnd=text.indexOf(suffix,bodyStart),end=bodyEnd+suffix.length;
  if(bodyEnd<0)return null;
  const body=text.slice(bodyStart,bodyEnd);
  sections.push({id,label,format:id.startsWith('brief.')?(body.startsWith(MODEL_DATA_PREFIX)?'compact':'json'):'text',text:body,start:cursor,bodyStart,bodyEnd,end});
  ids.add(id);cursor=end;
 }
 return sections.length?sections:null;
}
/** Reassemble the actual JSON material for diagnostics and prompt contract tests. */
export function readPromptMaterial(text:string):Record<string,any> {
 const sections=readPromptSections(text);if(!sections)throw Error('Prompt sections unavailable');
 return Object.fromEntries(sections.filter(s=>s.id.startsWith('brief.')).flatMap(s=>Object.entries(readPromptSectionData(s.text) as Record<string,unknown>)));
}
