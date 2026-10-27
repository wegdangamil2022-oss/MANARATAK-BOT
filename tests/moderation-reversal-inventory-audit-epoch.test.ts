import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation,type AuditRecord} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {moderationReviewEvidenceDigest} from '../src/moderation-review-integrity.js';
import {groupReversalInventory,renderReversalInventory,reversalInventoryDigest} from '../src/moderation-reversal-inventory.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-100123',OTHER='-100456',TARGET='300',HIDDEN='399';
const event=(id:number,key:string)=>({
 update_id:id,callback_query:{id:'epoch_'+id,from:{id:100,is_bot:false},
 data:key,message:{message_id:56,chat:{id:100,type:'private'},from:{id:999,is_bot:true}}}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
function unknown(version:number,now:number):ModerationOperation{
 return {id:'secret-unknown-case',chatId:OTHER,memberId:HIDDEN,actorId:OWNER,
  kind:'MUTE',reasonFingerprint:'PRIVATE_HIDDEN_REASON',
  policyVersion:version,status:'UNKNOWN_OUTCOME',createdAt:now-20_000,
  attemptGateway:'TELEGRAM_API'};
}
function reviewed(op:ModerationOperation,at:number,legacy=false){
 const digest=moderationReviewEvidenceDigest(op);
 const record:ModerationOperation={...op,review:{
  decision:'ACKNOWLEDGED_UNRESOLVED',reviewedBy:OWNER,reviewedAt:at,
  policyVersion:op.policyVersion,...(legacy?{}:{evidenceDigest:digest})
 }};
 const audit:AuditRecord={
  updateKey:'owner:moderation:review:'+
   createHash('sha256').update('MODERATION:REVIEW:'+op.id).digest('hex').slice(0,32),
  decision:'ALLOW',actorId:OWNER,reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
  policyVersion:op.policyVersion,at,
  ...(legacy?{}:{moderationEvidenceDigest:digest})
 };
 return {record,audit};
}
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-inventory-audit-epoch-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER);
 await policy.approveChat(OWNER,GROUP,['navigation','moderation']);
 await policy.approveChat(OWNER,OTHER,['navigation','moderation']);
 const s=await store.snapshot();
 const group=s.chats.find(c=>c.id===GROUP)!;
 const otherVersion=s.chats.find(c=>c.id===OTHER)!.version;
 const now=Date.now();
 const confirmed:ModerationOperation={
  id:'confirmed-private-case',chatId:GROUP,memberId:TARGET,actorId:OWNER,
  kind:'BAN',reasonFingerprint:'PRIVATE_CONFIRMED_FINGERPRINT',
  policyVersion:group.version,status:'CONFIRMED',
  createdAt:now-30_000,attemptGateway:'TELEGRAM_API'
 };
 await store.transaction(s=>s.moderationOperations.push(confirmed));
 const appendReview=async(at:number,legacy=false)=>{
  const e=reviewed(unknown(otherVersion,now),at,legacy);
  await store.transaction(s=>{s.moderationOperations.push(e.record);s.audit.push(e.audit);});
  return e;
 };
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 // The real update adapter durably deduplicates Telegram update_id. A test
 // must NEVER replay event(80) after an old callback: use ascending IDs.
 let updateId=100;
 const call=(key:string)=>app().handle(event(++updateId,key));
 const details=()=>call('mi:1:g:d:'+GROUP+':'+group.version+':0');
 const token=async()=>{
  const card=await details();
  const value=buttons(card).find(x=>x.callback_data.startsWith('mi:1:g:r:'))?.callback_data;
  assert.ok(value);return value;
 };
 return {store,policy,group,now,appendReview,app,call,details,token,
  close:()=>rm(dir,{force:true,recursive:true})};
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' owner inventory never advertises inspection while another chat has future-dated bound owner review',async()=>{
  const f=await fixture(engine);try{
   await f.appendReview(f.now+3_600_000);
   const s=await f.store.snapshot();
   const v=groupReversalInventory(s,f.policy,f.group);
   assert.equal(v.total,1);
   assert.equal(v.inspect,0);
   assert.equal(v.unproven,1);
   const message=renderReversalInventory(s,f.policy,f.group);
   assert.match(message,/مرشحة لفحص خارجي: 0/);
   assert.match(message,/نقص أدلة: 1/);
   assert.doesNotMatch(message,/PRIVATE_HIDDEN_REASON|PRIVATE_CONFIRMED_FINGERPRINT|399/);
   const old=await f.token();
   const screen=await f.call(old);
   assert.equal(screen.status,'APPLIED');
   assert.match(screen.plan?.text??'',/مرشحة لفحص خارجي: 0/);
   assert.match(screen.plan?.text??'',/نقص أدلة: 1/);
  }finally{await f.close();}
 });
 test(engine+' past-dated valid owner audit still allows non-authoritative inspection count in other chat',async()=>{
  const f=await fixture(engine);try{
   await f.appendReview(f.now-1000);
   const s=await f.store.snapshot();
   const v=groupReversalInventory(s,f.policy,f.group);
   assert.equal(v.inspect,1);
   assert.equal(v.unproven,0);
   assert.match(renderReversalInventory(s,f.policy,f.group),/مرشحة لفحص خارجي: 1/);
  }finally{await f.close();}
 });
 test(engine+' legacy unbound FUTURE owner review blocks optimistic inspection until clock catches up',async()=>{
  const f=await fixture(engine);try{
   await f.appendReview(f.now+3_600_000,true);
   const s=await f.store.snapshot();
   assert.equal(groupReversalInventory(s,f.policy,f.group).inspect,0);
   assert.equal(groupReversalInventory(s,f.policy,f.group).unproven,1);
  }finally{await f.close();}
 });
 test(engine+' cross-group audit mutation expires a previously issued owner reversal button',async()=>{
  const f=await fixture(engine);try{
   await f.appendReview(f.now-1000);
   const old=await f.token();
   const original=await f.call(old);
   assert.equal(original.status,'APPLIED');
   assert.match(original.plan?.text??'',/مرشحة لفحص خارجي: 1/);
   const before=await f.store.snapshot();
   await f.store.transaction(s=>{
    const a=s.audit.find(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED')!;
    a.actorId='401';
   });
   const after=await f.store.snapshot();
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
   assert.deepEqual(after.chats,before.chats);
   assert.deepEqual(after.moderationReasons,before.moderationReasons);
   const stale=await f.call(old);
   assert.equal(stale.status,'DENIED');
   const next=await f.token();
   assert.notEqual(old,next);
   const fresh=await f.call(next);
   assert.equal(fresh.status,'APPLIED');
   assert.match(fresh.plan?.text??'',/مرشحة لفحص خارجي: 0/);
   assert.match(fresh.plan?.text??'',/نقص أدلة: 1/);
   assert.doesNotMatch(fresh.plan?.text??'',/PRIVATE_|secret-unknown|399|401/);
   const final=await f.store.snapshot();
   // A rejected stale callback deliberately appends a local DENY audit.
   // Preserve the original moderation and owner-review evidence unchanged.
   assert.deepEqual(final.moderationOperations,after.moderationOperations);
   assert.deepEqual(final.moderationReasons,after.moderationReasons);
   assert.deepEqual(final.chats,after.chats);
   assert.deepEqual(final.audit.filter(a=>
    a.updateKey.startsWith('owner:moderation:review:')),
    after.audit.filter(a=>a.updateKey.startsWith('owner:moderation:review:')));
   assert.equal(final.audit.some(a=>a.reason==='INVALID_OR_STALE_GROUP_CALLBACK'),true);
  }finally{await f.close();}
 });
 test(engine+' losing external audit evidence invalidates group token even if group operations stay unchanged',async()=>{
  const f=await fixture(engine);try{
   await f.appendReview(f.now-1000);
   const old=await f.token();
   await f.store.transaction(s=>s.audit=s.audit.filter(a=>
    a.reason!=='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED'));
   assert.equal((await f.call(old)).status,'DENIED');
   const fresh=await f.call(await f.token());
   assert.match(fresh.plan?.text??'',/مرشحة لفحص خارجي: 0/);
  }finally{await f.close();}
 });
}
test('reversal inventory digest depends on moderation-owner audit receipts, not unrelated audit noise',async()=>{
 const f=await fixture('json');try{
  await f.appendReview(f.now-1000);
  const before=await f.store.snapshot();
  const first=reversalInventoryDigest(before,f.group);
  await f.store.transaction(s=>s.audit.push({
   updateKey:'owner:regular:faq',decision:'ALLOW',reason:'SAFE_MISC_EVENT',
   policyVersion:1,at:f.now
  }));
  const second=await f.store.snapshot();
  assert.equal(reversalInventoryDigest(second,f.group),first);
  await f.store.transaction(s=>s.audit.find(a=>
   a.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED')!.at+=1);
  const third=await f.store.snapshot();
  assert.notEqual(reversalInventoryDigest(third,f.group),first);
 }finally{await f.close();}
});
test('expired permission cannot turn a rejected inventory route into a release action',async()=>{
 const f=await fixture('json');try{
  await f.appendReview(f.now+3_600_000);
  const button=await f.token();
  await f.policy.approveChat(OWNER,GROUP,['navigation']);
  assert.equal((await f.call(button)).status,'DENIED');
 }finally{await f.close();}
});
