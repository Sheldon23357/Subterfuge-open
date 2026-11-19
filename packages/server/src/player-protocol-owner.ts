import {createHash} from 'node:crypto';
import {canonicalProtocolJson,type ProtocolScope,type ProtocolOwnerCommanderView} from '../../contracts/src/index.js';
import type {CommanderThread} from '../../contracts/src/index.js';
/** Confirmation binds exact content, stable owner identity, epoch and base version, not a caller-supplied role. */
export function ownerCommanderView(scope:ProtocolScope,thread:CommanderThread):ProtocolOwnerCommanderView{return{scope,thread,proposals:thread.messages.flatMap(message=>{const proposal=message.proposal;if(!proposal)return[];const contentDigest=createHash('sha256').update(canonicalProtocolJson({roomEpoch:scope.roomEpoch,playerId:scope.playerId,proposalId:proposal.id,baseVersion:String(proposal.baseVersion),text:proposal.text})).digest('hex');return[{proposalId:proposal.id,baseVersion:String(proposal.baseVersion),contentDigest,status:proposal.status,text:proposal.text}];})};}
