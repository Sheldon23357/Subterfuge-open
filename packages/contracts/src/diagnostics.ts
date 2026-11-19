export interface ErrorDiagnostic {
  name:string;
  message?:string;
  code?:string;
  syscall?:string;
  errno?:number;
  stack?:string;
  causes?:ErrorDiagnostic[];
}

/** Bounded diagnostics only. Never serialize an error's arbitrary properties,
 * request headers, response bodies, or provider output. */
export function diagnosticText(text:string,limit=600){
  const location=(path:string)=>{const name=path.split(/[\\/]/).at(-1)??'';return /^[\w.-]+\.(?:[cm]?js|tsx?):\d+:\d+$/.test(name)?name:'[path]';};
  return text
    .replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [redacted]')
    .replace(/((?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi,'$1[redacted]')
    .replace(/\bsk-[\w-]{8,}\b/g,'[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,'[redacted]')
    .replace(/file:\/\/\/[^\s"'<>)]*/gi,location)
    .replace(/https?:\/\/[^\s"'<>]+/gi,'[url]')
    .replace(/\b[A-Z]:[\\/][^\r\n"<>)]*/gi,location)
    .replace(/\/(?:Users|home|tmp|private|workspace)\/[^\s"<>)]*/g,location)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g,' ')
    .slice(0,limit);
}

export function errorDiagnostic(error:unknown,includeStack=false):ErrorDiagnostic{
  const seen=new Set<unknown>();
  let remaining=12;
  const visit=(value:unknown,depth:number):ErrorDiagnostic=>{
    if(remaining--<=0)return {name:'CauseLimit'};
    if(!value||typeof value!=='object')return {name:'NonErrorThrown',...(typeof value==='string'?{message:diagnosticText(value)}:{})};
    if(seen.has(value))return {name:'CircularCause'};
    seen.add(value);
    const e=value as {name?:unknown;message?:unknown;code?:unknown;syscall?:unknown;errno?:unknown;stack?:unknown;cause?:unknown;errors?:unknown};
    const causes=[...(e.cause!==undefined?[e.cause]:[]),...(Array.isArray(e.errors)?e.errors.slice(0,3):[])];
    return {name:typeof e.name==='string'?diagnosticText(e.name,80):'Error',
      ...(typeof e.message==='string'?{message:e.name==='SyntaxError'?'Invalid syntax or JSON; raw input omitted':diagnosticText(e.message)}:{}),
      ...(typeof e.code==='string'?{code:diagnosticText(e.code,80)}:{}),
      ...(typeof e.syscall==='string'?{syscall:diagnosticText(e.syscall,80)}:{}),
      ...(typeof e.errno==='number'&&Number.isFinite(e.errno)?{errno:e.errno}:{}),
      ...(includeStack&&e.name!=='SyntaxError'&&typeof e.stack==='string'?{stack:diagnosticText(e.stack.split('\n').slice(1,7).join('\n'),1200)}:{}),
      ...(depth<3&&causes.length?{causes:causes.map(c=>visit(c,depth+1))}:{})};
  };
  try{return visit(error,0);}catch{return {name:'UninspectableError'};}
}
