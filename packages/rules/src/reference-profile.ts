/** Locked research profile; gameplay imports index.ts. */
import profile from '../../../docs/rules/data/profile-4300.json' with {type:'json'};
function freeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

export const RULES=freeze(profile);
