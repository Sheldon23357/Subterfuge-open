/** Count spans in the final rendered JSON. Re-serializing parsed objects loses
 * duplicate display keys, whitespace and the column-table representation. */
interface Node {start:number;end:number;items?:Node[];properties?:Map<string,Node>}
export const RECEIPT_MEASUREMENT='rendered-receipts/1';
export interface ReceiptCharacters {tools:Record<string,number>;structure:number;unavailable:number}
export interface PromptReceiptBreakdown extends ReceiptCharacters {measurement:typeof RECEIPT_MEASUREMENT;total:number}

function parse(text:string):Node {
  JSON.parse(text); // Reject malformed or clipped archives before measuring.
  let at=0;
  const space=()=>{while(/\s/.test(text[at]??'')&&at<text.length)at++;};
  const string=()=>{const start=at++;while(at<text.length){const c=text[at++];if(c==='\\')at++;else if(c==='"')break;}return {start,end:at};};
  function value(depth=0):Node{
    if(depth>128)throw Error('Receipt JSON nesting exceeds accounting limit');
    space();const start=at,c=text[at];
    if(c==='"')return string();
    if(c==='['){
      at++;space();const items:Node[]=[];
      while(text[at]!==']'){items.push(value(depth+1));space();if(text[at]===','){at++;space();}else break;}
      at++;return {start,end:at,items};
    }
    if(c==='{'){
      at++;space();const properties=new Map<string,Node>();
      while(text[at]!=='}'){
        const key=string();space();at++;const child=value(depth+1);
        properties.set(JSON.parse(text.slice(key.start,key.end)),child);space();
        if(text[at]===','){at++;space();}else break;
      }
      at++;return {start,end:at,properties};
    }
    while(at<text.length&&!/[\s,\]}]/.test(text[at]!))at++;
    return {start,end:at};
  }
  return value();
}

export function renderedReceiptCharacters(text:string):ReceiptCharacters{
  const tools:Record<string,number>={};
  const add=(tool:string,n:number)=>{tools[tool]=(tools[tool]??0)+n;};
  try{
    const root=parse(text);
    const scalar=(n:Node|undefined):unknown=>n?JSON.parse(text.slice(n.start,n.end)):undefined;
    const prop=(n:Node|undefined,key:string)=>n?.properties?.get(key);
    function entry(n:Node,tool:unknown,argumentsNode?:Node,resultNode?:Node):number{
      if(typeof tool!=='string'||!tool){const length=n.end-n.start;add('unclassified',length);return length;}
      const length=n.end-n.start;add(tool,length);
      if(tool==='queries'){
        // Child spans live inside the wrapper; transfer, never count twice.
        const children=walk(prop(argumentsNode,'queries'))+walk(prop(resultNode,'results'));
        add(tool,-children);
      }
      return length;
    }
    function walk(n:Node|undefined):number{
      if(!n)return 0;
      if(n.items)return n.items.reduce((sum,child)=>sum+walk(child),0);
      if(scalar(prop(n,'encoding'))==='column-groups/1'){
        let measured=0;
        for(const group of prop(n,'groups')?.items??[]){
          const fields=prop(group,'fields')?.items?.map(scalar)??[];
          const tool=fields.indexOf('tool'),args=fields.indexOf('arguments'),result=fields.indexOf('result');
          for(const cells of prop(group,'rows')?.items??[]){
            if(!cells.items)continue;
            measured+=entry(cells,tool<0?undefined:scalar(cells.items[tool+1]),args<0?undefined:cells.items[args+1],result<0?undefined:cells.items[result+1]);
          }
        }
        return measured;
      }
      return entry(n,scalar(prop(n,'tool')),prop(n,'arguments'),prop(n,'result'));
    }
    walk(root);
    const classified=Object.values(tools).reduce((a,b)=>a+b,0);
    if(classified>text.length||Object.values(tools).some(n=>n<0))throw Error('Overlapping receipt spans');
    return {tools,structure:text.length-classified,unavailable:0};
  }catch{return {tools:{},structure:0,unavailable:text.length};}
}

/** Reconstruct only from complete captured module lines. Incomplete archives
 * remain unavailable; never estimate tool proportions or alter stored prompts. */
export function promptReceiptBreakdown(prompt:string):PromptReceiptBreakdown|undefined{
  const markers=['最近决策与回执：','本轮行动与回执（按执行顺序）：'];
  const tools:Record<string,number>={};let total=0,structure=0,unavailable=0;
  for(const marker of markers){
    const offset=prompt.startsWith(marker)?0:prompt.indexOf('\n'+marker)+1;
    if(offset===0&&!prompt.startsWith(marker))return;
    const start=offset+marker.length,end=prompt.indexOf('\n',start);
    if(end<0)return;
    const measured=renderedReceiptCharacters(prompt.slice(start,end));
    for(const [tool,n] of Object.entries(measured.tools))tools[tool]=(tools[tool]??0)+n;
    total+=end+1-offset;structure+=measured.structure+marker.length+1;unavailable+=measured.unavailable;
  }
  return {measurement:RECEIPT_MEASUREMENT,total,tools,structure,unavailable};
}
