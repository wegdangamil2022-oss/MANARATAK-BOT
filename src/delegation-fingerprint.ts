import {createHash} from 'node:crypto';
import type {BotState,Capability} from './store.js';
/** Change detector over the entire relevant ledger and approval epoch. */
export function delegationFingerprint(s:BotState,actor:string,capability:Capability,chatId:string):string{
 const history=s.grants.filter(g=>g.actor===actor&&g.capability===capability&&g.chatId===chatId)
  .map(g=>JSON.stringify([g.actor,g.capability,g.chatId,g.expiresAt,g.grantedBy,g.revoked,g.chatPolicyVersion??null,g.grantId??null])).sort();
 const chats=s.chats.filter(c=>c.id===chatId).map(c=>[c.id,c.approved,c.version,c.scopes]);
 return createHash('sha256').update(JSON.stringify([history,chats])).digest('hex');
}
