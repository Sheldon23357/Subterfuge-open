/** Neutral default for calls without a business contract. Real decisions supply a schema. */
export const EMPTY_MODEL_SCHEMA={type:'object',properties:{},required:[],additionalProperties:false};
export const MODEL_REPLY_CHAR_LIMIT=55000;
/** Non-action model results never pass through the game tool parser. */
export class SemanticReplyParseError extends Error {
 constructor(readonly reason:'invalid-semantic-json'|'invalid-semantic-object'|'semantic-output-limit',readonly offset?:number){super(reason);}
}
/** Accept one JSON code fence or a JSON-encoded JSON string, without repairing
 * syntax, extracting arbitrary prose or interpreting a game tool envelope. */
function modelJson(text:string):unknown {
 let source=text.replace(/^\uFEFF/,'').trim();
 const fenced=/^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(source);
 if(fenced)source=fenced[1]!;
 const value:unknown=JSON.parse(source);
 return typeof value==='string'?JSON.parse(value):value;
}
export function parseModelJson(text:string):Record<string,unknown> {
 if(text.length>MODEL_REPLY_CHAR_LIMIT)throw new SemanticReplyParseError('semantic-output-limit');
 let value:unknown;
 try{value=modelJson(text);}catch(error){const offset=error instanceof SyntaxError?/position (\d+)/.exec(error.message)?.[1]:undefined;throw new SemanticReplyParseError('invalid-semantic-json',offset===undefined?undefined:Number(offset));}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new SemanticReplyParseError('invalid-semantic-object');
 return value as Record<string,unknown>;
}
