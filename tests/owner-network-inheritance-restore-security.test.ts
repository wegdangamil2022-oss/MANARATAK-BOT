import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validNetworkInheritanceLink,validNetworkInheritanceLinks,
 type NetworkInheritanceLink} from '../src/network-inheritance-model.js';

/** Restore-path validation must fail closed before any inherited configuration
 * is trusted. These tests intentionally do not contact Telegram. */
const base:NetworkInheritanceLink={
 id:'abcdef123456',kind:'POLICY',networkId:'112233445566',
 networkRevision:1,sourceChatId:'-100123',sourceChatVersion:1,
 sourceRevision:1,targetChatId:'-100124',targetChatVersion:1,
 targetRevision:1,targetDigest:'a'.repeat(64),createdAt:1700000000000,
 lastSyncedAt:1700000000000,status:'ACTIVE'
};
const copy=(changes:Record<string,unknown>={}):unknown=>({...base,...changes});
test('NETWORK-002 restored inheritance accepts canonical active and paused records',()=>{
 assert.equal(validNetworkInheritanceLink(base),true);
 assert.equal(validNetworkInheritanceLink(copy({status:'PAUSED',pausedReason:'OWNER_PAUSED'})),true);
 assert.equal(validNetworkInheritanceLinks([base]),true);
});
for(const [name,patch] of [
 ['unrecognized kind',{kind:'ENFORCE'}],
 ['unexpected key',{token:'secret'}],
 ['missing source',{sourceChatId:undefined}],
 ['same source and target',{targetChatId:base.sourceChatId}],
 ['non-Telegram target',{targetChatId:'100124'}],
 ['zero source revision',{sourceRevision:0}],
 ['fractional network revision',{networkRevision:1.5}],
 ['negative target revision',{targetRevision:-1}],
 ['noncanonical link ID',{id:'ABCDEF123456'}],
 ['noncanonical digest',{targetDigest:'F'.repeat(64)}],
 ['malformed digest',{targetDigest:'a'.repeat(63)}],
 ['future source time',{createdAt:-1}],
 ['clock reversal',{lastSyncedAt:base.createdAt-1}],
 ['unknown status',{status:'RUNNING'}],
 ['active with pause reason',{pausedReason:'OWNER_PAUSED'}],
 ['paused without reason',{status:'PAUSED'}],
 ['paused with unknown reason',{status:'PAUSED',pausedReason:'EXPIRED'}],
 ['boolean version',{sourceChatVersion:true}],
 ['nonfinite version',{targetChatVersion:Infinity}],
 ['source ID out of safe range',{sourceChatId:'-9999999999999999'}],
] as const){
 test('NETWORK-002 rejects invalid restored link: '+name,()=>{
  assert.equal(validNetworkInheritanceLink(copy(patch)),false);
  assert.equal(validNetworkInheritanceLinks([copy(patch)]),false);
 });
}
test('NETWORK-002 rejects unknown fields and missing required fields independently',()=>{
 for(const key of Object.keys(base)){
  const bad={...base} as Record<string,unknown>;delete bad[key];
  assert.equal(validNetworkInheritanceLink(bad),false,'required: '+key);
 }
 assert.equal(validNetworkInheritanceLink({...base,pausedReason:undefined}),false);
});
test('NETWORK-002 restored snapshot rejects duplicate link IDs',()=>{
 assert.equal(validNetworkInheritanceLinks([base,copy({targetChatId:'-100125'})]),false);
});
test('NETWORK-002 restored snapshot rejects duplicate destinations across networks',()=>{
 assert.equal(validNetworkInheritanceLinks([base,copy({
  id:'bbbbbbbbbbbb',networkId:'222222222222',sourceChatId:'-100126'
 })]),false);
});
test('NETWORK-002 restored snapshot rejects active dependency chains',()=>{
 const next=copy({id:'bbbbbbbbbbbb',sourceChatId:base.targetChatId,
  targetChatId:'-100125'});
 assert.equal(validNetworkInheritanceLinks([base,next]),false);
 assert.equal(validNetworkInheritanceLinks([next,base]),false);
});
test('NETWORK-002 restored snapshot rejects active cycles',()=>{
 const back=copy({id:'bbbbbbbbbbbb',sourceChatId:base.targetChatId,
  targetChatId:base.sourceChatId});
 assert.equal(validNetworkInheritanceLinks([base,back]),false);
});
test('NETWORK-002 paused links cannot trigger propagation or active-cycle rejection',()=>{
 const paused=copy({id:'bbbbbbbbbbbb',sourceChatId:base.targetChatId,
  targetChatId:base.sourceChatId,status:'PAUSED',pausedReason:'LOCAL_OVERRIDE'});
 assert.equal(validNetworkInheritanceLinks([base,paused]),true);
});
test('NETWORK-002 different policy/greeting types have isolated dependency graphs',()=>{
 const greeting=copy({id:'bbbbbbbbbbbb',kind:'GREETING',
  sourceChatId:base.targetChatId,targetChatId:base.sourceChatId});
 assert.equal(validNetworkInheritanceLinks([base,greeting]),true);
});
test('NETWORK-002 independent same-source fanout is valid',()=>{
 const sibling=copy({id:'bbbbbbbbbbbb',targetChatId:'-100125'});
 assert.equal(validNetworkInheritanceLinks([base,sibling]),true);
});
test('NETWORK-002 inheritance snapshot caps total links at 500',()=>{
 const items=Array.from({length:501},(_,i)=>copy({
  id:i.toString(16).padStart(12,'0'),targetChatId:'-'+String(100000+i)
 }));
 assert.equal(validNetworkInheritanceLinks(items),false);
});
test('NETWORK-002 inheritance snapshot rejects nonarrays',()=>{
 for(const value of [undefined,null,{},'[]',42,true])assert.equal(
  validNetworkInheritanceLinks(value),false);
});
