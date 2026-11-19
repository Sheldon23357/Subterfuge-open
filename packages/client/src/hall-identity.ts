import {rememberPlayerSeat} from './player-route.js';
interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const claimPrefix = 'subterfuge-hall-claim-';
const activeKey = 'subterfuge-hall-active';
const sessionKeys = ['subterfuge-player-code', 'subterfuge-room-code', 'subterfuge-hub-room-id'] as const;
export function hasHallClaim(session: IdentityStorage, persistent: IdentityStorage, code: string) {
  return !!(persistent.getItem(claimPrefix + code) || session.getItem(claimPrefix + code));
}
export function hallClaim(session: IdentityStorage, persistent: IdentityStorage, code: string, generate: () => string) {
  const name = claimPrefix + code;
  const claim = persistent.getItem(name) || session.getItem(name) || generate();
  // Persist before sending: a failed write must never silently claim another seat.
  persistent.setItem(name, claim);
  session.setItem(name, claim);
  return claim;
}
export function rememberHallIdentity(session: IdentityStorage, persistent: IdentityStorage, value: {playerToken: string; code: string; roomId: string;seat?:number;player?:number}) {
  const seat=value.seat??value.player;
  if(seat!==undefined){rememberPlayerSeat(persistent,{...value,seat});session.setItem('subterfuge-hall-seat',String(seat));}else session.removeItem('subterfuge-hall-seat');
  persistent.setItem('subterfuge-hall-identity-' + value.code, JSON.stringify(value));
  const identity = [value.playerToken, value.code, value.roomId];
  persistent.setItem(activeKey, JSON.stringify(identity));
  sessionKeys.forEach((key, index) => session.setItem(key, identity[index]!));
}
export function rememberHallAdmission(session: IdentityStorage, persistent: IdentityStorage, value: {playerToken: string; code: string; roomId: string;seat?:number;player?:number}, claim: string, creating: boolean) {
  persistent.setItem(claimPrefix + value.code, claim);
  session.setItem(claimPrefix + value.code, claim);
  rememberHallIdentity(session,persistent,value);
  if (creating) {
    persistent.removeItem(claimPrefix + 'create');
    session.removeItem(claimPrefix + 'create');
  }
}
export function restoreHallIdentity(session: IdentityStorage, persistent: IdentityStorage) {
  // An existing tab keeps its own room even if another tab enters a different one.
  if (session.getItem(sessionKeys[0])) {
    const current = sessionKeys.map(key => session.getItem(key));
    if (current.every(Boolean)) {
      if (!persistent.getItem(activeKey)) persistent.setItem(activeKey, JSON.stringify(current));
      const name = claimPrefix + current[1];
      const claim = session.getItem(name);
      if (claim) persistent.setItem(name, claim);
    }
    return;
  }
  const saved = persistent.getItem(activeKey);
  if (!saved) return;
  let identity: unknown;
  try { identity = JSON.parse(saved); } catch { return; }
  if (!Array.isArray(identity) || identity.length !== 3 || !identity.every(value => typeof value === 'string' && value.length > 0)) return;
  sessionKeys.forEach((key, index) => session.setItem(key, identity[index]));
}
export function forgetActiveHallIdentity(session: IdentityStorage, persistent: IdentityStorage) {
  const saved = persistent.getItem(activeKey);
  if (saved) {
    try {
      if (JSON.parse(saved)[0] === session.getItem(sessionKeys[0])) persistent.removeItem(activeKey);
    } catch { /* Ignore corrupt local metadata. */ }
  }
}
