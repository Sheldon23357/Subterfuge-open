import type {Agreement} from './contracts.js';
export function effectiveAgreement(a:Agreement,now:number){return ['proposed','negotiating','confirmed'].includes(a.status)&&(a.expiresWorldDay===null||a.expiresWorldDay>now)&&(a.status==='confirmed'||a.tick+72>now);}
