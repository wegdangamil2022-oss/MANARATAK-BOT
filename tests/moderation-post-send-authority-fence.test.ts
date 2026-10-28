import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway} from '../src/moderation.js';

const OWNER='100',STAFF='200',TARGET='300',CHAT='-100123';
const OTHER='-100456',NOW=1_800_000_000_000;
type Scenario='REVOKE_GROUP'|'REVOKE_ACTOR'|'PROTECT_TARGET'|'ALTER_REASON'|
 'REVOKE_OTHER_GROUP'|'STABLE'|'CALLBACK_STALE'|'FAILED_AFTER_CHANGE';
async function exercise(engine:'json'|'sqlite',scenario:Scenario){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-post-send-authority-'));
 try{
  const store=new BotStore(join(dir,engine==='json'?'bot.json':'bot.sqlite'),{engine});
  const policy=new Policy(store,OWNER,()=>NOW);
  await policy.approveChat(OWNER,CHAT,['moderation']);
  if(scenario==='REVOKE_OTHER_GROUP')
   await policy.approveChat(OWNER,OTHER,['moderation']);
  const actor=scenario==='REVOKE_ACTOR'?STAFF:OWNER;
  if(actor===STAFF)
   await policy.grant(OWNER,STAFF,'chat.manage',CHAT,NOW+100_000);
  let sends=0,preflight=true,callbackCurrent=true;
  const gateway:ModerationGateway={
   canRestrict:async()=>true,isProtected:async()=>false,
   setRestriction:async(_chat,_member,kind,verify)=>{
    sends++;
    assert.equal(kind,'BAN');
    assert.equal((await store.snapshot()).moderationOperations.at(-1)?.status,'STARTED');
    // The gateway completed its last-mile authorization BEFORE its one
    // irreversible provider request. Simulate the request returning later.
    assert.equal(await verify?.(),true);
    switch(scenario){
     case 'REVOKE_GROUP':await policy.revokeChat(OWNER,CHAT);break;
     case 'REVOKE_ACTOR':
      await policy.revokeGrant(OWNER,STAFF,'chat.manage',CHAT);break;
     case 'PROTECT_TARGET':
      await policy.grant(OWNER,TARGET,'chat.manage',CHAT,NOW+100_000);break;
     case 'ALTER_REASON':
      await store.transaction(s=>{s.moderationReasons[0]!.reference='edited-in-flight';});break;
     case 'REVOKE_OTHER_GROUP':await policy.revokeChat(OWNER,OTHER);break;
     case 'CALLBACK_STALE':callbackCurrent=false;break;
     case 'FAILED_AFTER_CHANGE':await policy.revokeChat(OWNER,CHAT);break;
    }
    return scenario==='FAILED_AFTER_CHANGE'?'FAILED_CONFIRMED':'CONFIRMED';
   }
  };
  const service=new ModerationService(store,policy,gateway,()=>NOW);
  let result;
  if(scenario==='CALLBACK_STALE'){
   await store.transaction(s=>s.moderationReasons.push({
    chatId:CHAT,memberId:TARGET,source:'MANUAL',reference:'policy-fence',
    kind:'BAN',createdBy:OWNER,active:true
   }));
   const witness=()=>callbackCurrent;
   result=await service.reconcile(actor,CHAT,TARGET,witness);
  }else result=await service.addManualReason(actor,CHAT,TARGET,'policy-fence','BAN');
  assert.equal(sends,1,'a mock provider request may already have occurred once');
  const state=await store.snapshot();
  assert.equal(state.moderationOperations.length,1);
  const row=state.moderationOperations[0]!;
  assert.equal(row.kind,'BAN');
  assert.equal(row.memberId,TARGET);
  assert.equal(row.actorId,actor);
  const shouldQuarantine=!['STABLE','REVOKE_OTHER_GROUP','FAILED_AFTER_CHANGE'].includes(scenario);
  assert.equal(result.status,shouldQuarantine?'BLOCKED_UNKNOWN':
   scenario==='FAILED_AFTER_CHANGE'?'FAILED_CONFIRMED':'APPLIED');
  assert.equal(row.status,shouldQuarantine?'UNKNOWN_OUTCOME':
   scenario==='FAILED_AFTER_CHANGE'?'FAILED_CONFIRMED':'CONFIRMED');
  if(shouldQuarantine){
   // Failed/blocked repeated requests cannot replay a possibly sent action.
   assert.equal((await service.reconcile(OWNER,CHAT,TARGET)).status,
    scenario==='REVOKE_GROUP'?'DENIED':'BLOCKED_UNKNOWN');
   assert.equal(sends,1);
   assert.equal(JSON.stringify(result).includes('edited-in-flight'),false);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
}
for(const engine of ['json','sqlite'] as const){
 for(const scenario of ['REVOKE_GROUP','REVOKE_ACTOR','PROTECT_TARGET','ALTER_REASON',
  'CALLBACK_STALE','STABLE','REVOKE_OTHER_GROUP','FAILED_AFTER_CHANGE'] as const){
  test(engine+' post-provider result authority fence: '+scenario,
   async()=>exercise(engine,scenario));
 }
}
