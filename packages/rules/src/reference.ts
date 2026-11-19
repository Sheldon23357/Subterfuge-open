/** Archival source metadata for extracted reference implementations only. */
import specialistData from '../../../docs/rules/data/specialists.json' with {type:'json'};
import rulebookData from '../../../docs/rules/data/rules.json' with {type:'json'};
function freeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

export {RULES} from './reference-profile.js';
export const SPECIALISTS=freeze(specialistData);
export const RULEBOOK=freeze(rulebookData);
