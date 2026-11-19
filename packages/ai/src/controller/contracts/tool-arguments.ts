/** Only normalize unambiguous transport syntax. Never guess missing fields,
 * close truncated objects, change quotes, or evaluate model-produced code. */
export class ToolArgumentsError extends Error {
  constructor(readonly detail:{reason:string;position?:number;line?:number;column?:number;excerpt?:string}){super('Invalid tool JSON');}
}
/** V8 sometimes omits the offset in its error. This scanner is diagnostics
 * only; JSON.parse remains the sole parser and no guessed input is executed. */
function errorPosition(source:string){
  let at=0;
  const fail=():never=>{throw at;};
  const space=()=>{while(/[\x20\t\r\n]/.test(source[at]??'x'))at++;};
  const string=()=>{
    if(source[at++]!=='"'){at--;fail();}
    while(at<source.length){
      const ch=source[at++]!;
      if(ch==='"')return;
      if(ch<' '){at--;fail();}
      if(ch==='\\'){
        if(source[at]==='u'){at++;for(let i=0;i<4;i++,at++)if(!/[0-9a-f]/i.test(source[at]??''))fail();}
        else if(/["\\/bfnrt]/.test(source[at]??''))at++;
        else fail();
      }
    }fail();
  };
  const value=(depth:number)=>{
    space();if(depth>128)fail();
    const ch=source[at];
    if(ch==='"'){string();return;}
    if(ch==='{'||ch==='['){
      const end=ch==='{'?'}':']';at++;space();if(source[at]===end){at++;return;}
      for(;;){
        if(ch==='{'){space();string();space();if(source[at]!==':')fail();at++;}
        value(depth+1);space();if(source[at]===end){at++;return;}if(source[at]!==',')fail();at++;
      }
    }
    const literal=ch==='t'?'true':ch==='f'?'false':ch==='n'?'null':undefined;
    if(literal){for(const expected of literal){if(source[at]!==expected)fail();at++;}return;}
    const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at));
    if(number){at+=number[0].length;return;}
    fail();
  };
  try{value(0);space();if(at<source.length)fail();}catch{}
  return at;
}
export function parseToolArguments(raw:string|Record<string,unknown>){
  if(typeof raw!=='string'){
    if(raw&&typeof raw==='object'&&!Array.isArray(raw))return {args:raw,repairs:[] as string[]};
    throw new ToolArgumentsError({reason:'Arguments must be a JSON object'});
  }
  let source=raw.trim(),repairs:string[]=[];
  if(source.charCodeAt(0)===0xFEFF){source=source.slice(1).trim();repairs.push('bom');}
  const fenced=/^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(source);
  if(fenced){source=fenced[1]!.trim();repairs.push('code-fence');}
  // Remove trailing commas only outside quoted strings, including escaped
  // quotes. Literal message/strategy contents are preserved byte for byte.
  let clean='',quoted=false,escaped=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i]!;
    if(quoted){clean+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"')quoted=true;
    if(ch===','&&/^\s*[}\]]/.test(source.slice(i+1))){if(!repairs.includes('trailing-comma'))repairs.push('trailing-comma');continue;}
    clean+=ch;
  }
  let args:unknown,parsing=clean;
  try{args=JSON.parse(parsing);if(typeof args==='string'){parsing=args;args=JSON.parse(parsing);repairs.push('double-encoded');}}
  catch(e){
    const reason=e instanceof Error?e.message:'Invalid JSON',match=/position (\d+)/.exec(reason),position=match?Number(match[1]):errorPosition(parsing);
    // Some providers append one unmatched closing brace after an otherwise
    // complete object. Repair only when the remaining suffix is exactly it.
    if(position>0&&parsing.slice(position).trim()==='}'){
      try{
        const candidate=JSON.parse(parsing.slice(0,position).trimEnd());
        if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)){
          args=candidate;repairs.push('extra-closing-brace');
        }
      }catch{}
    }
    if(args===undefined){
      const prefix=parsing.slice(0,position);
      throw new ToolArgumentsError({reason,position,line:prefix.split('\n').length,column:position-prefix.lastIndexOf('\n'),excerpt:parsing.slice(Math.max(0,position-60),position+60)});
    }
  }
  if(!args||typeof args!=='object'||Array.isArray(args))throw new ToolArgumentsError({reason:'Arguments must be a JSON object'});
  return {args:args as Record<string,unknown>,repairs};
}
