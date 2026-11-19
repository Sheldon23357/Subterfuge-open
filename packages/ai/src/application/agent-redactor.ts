import {encodePromptSections,readPromptSections} from '../../../contracts/src/index.js';
/** Diagnostics are local data, but model/player text can echo unrelated seat credentials. */
export function createDiagnosticRedactor(knownSecrets:()=>readonly string[]){
  return (value:unknown):unknown=>{
    const secrets=[...new Set(knownSecrets().filter(s=>typeof s==='string'&&s.length>0).flatMap(s=>[s,encodeURIComponent(s)]))].sort((a,b)=>b.length-a.length);
    let nodes=0,characters=0;
    const clean=(input:string)=>{
      let text=input;
      for(const secret of secrets)text=text.split(secret).join('[redacted]');
      text=text.replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [redacted]')
        .replace(/((?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi,'$1[redacted]')
        .replace(/\bsk-[\w-]{8,}\b/g,'[redacted]')
        .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,'[redacted]')
        .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,'$1[redacted]@')
        .replace(/([?&](?:token|api[_-]?key|access_token|secret|password)=)[^&#\s"']+/gi,'$1[redacted]');
      characters+=text.length;if(characters>1500000)throw Error('Diagnostic content exceeds safe limit');
      return text;
    };
    const visit=(item:unknown,depth:number):unknown=>{
      if(++nodes>20000||depth>24)throw Error('Diagnostic structure exceeds safe limit');
      if(typeof item==='string'){
        const sections=readPromptSections(item);
        if(!sections)return clean(item);
        // Reframe sanitized bodies so marker-like user text remains literal and
        // console offsets describe exactly the exported text, never the secret.
        const safe=sections.map(s=>({id:clean(s.id),label:clean(s.label),format:s.format,text:clean(s.text)}));
        const framed=encodePromptSections(safe);
        characters+=framed.length-safe.reduce((sum,s)=>sum+s.id.length+s.label.length+s.text.length,0);
        if(characters>1500000)throw Error('Diagnostic content exceeds safe limit');
        return framed;
      }
      if(item===null||typeof item==='boolean')return item;
      if(typeof item==='number')return Number.isFinite(item)?item:null;
      if(Array.isArray(item))return item.map(x=>visit(x,depth+1));
      if(item&&typeof item==='object'){
        const result:Record<string,unknown>=Object.create(null);
        for(const [key,child] of Object.entries(item)){
          if(['__proto__','prototype','constructor'].includes(key))continue;
          const safeKey=clean(key);
          result[safeKey]=/^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|client[-_]?secret|player[-_]?token|token|tokenEnv|storeDirectory|sessionId|headers|env|environment)$/i.test(key)?'[redacted]':visit(child,depth+1);
        }
        return result;
      }
      return null;
    };
    return visit(value,0);
  };
}
