import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService,type MembershipStatus} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-100123',CHANNEL='-100234',STUDENT=300;
function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(r=>{resolve=r;});
 return {resolve,promise};
}
const msg=(id:number,text:string)=>({update_id:id,message:{message_id:id,
 chat:{id:STUDENT,type:'private'},from:{id:STUDENT,is_bot:false},text}});
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-private-epochs-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'Secret Group Scholarship',order:1});
 const entered=deferred<void>(),membership=deferred<MembershipStatus>();
 const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=>{entered.resolve();return membership.promise;}});
 return {store,policy,entered,membership,app,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+' pending group membership cannot leak private group category after revoke and reapprove same scopes',async()=>{
  const f=await fixture(engine);try{
   const pending=f.app.handle(msg(1,'/categories '+GROUP));
   await f.entered.promise;
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation','verification']);
   f.membership.resolve('VERIFIED');
   const result=await pending;
   assert.equal(result.status,'DENIED');
   assert.equal(result.plan,undefined);
   assert.equal(result.reason,'MEMBERSHIP_UNAVAILABLE');
  }finally{await f.close();}
 });
}
test('B3 pending private group resource listing cannot use old membership after benign-looking policy version change',async()=>{
 const f=await fixture();try{
  const pending=f.app.handle(msg(2,'/resources '+GROUP+' grants'));
  await f.entered.promise;
  await f.policy.approveChat(OWNER,GROUP,['verification','navigation']);
  f.membership.resolve('VERIFIED');
  const result=await pending;
  assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
 }finally{await f.close();}
});
test('B3 new mandatory-channel subscription during in-flight membership check cannot be silently bypassed',async()=>{
 const f=await fixture();try{
  const pending=f.app.handle(msg(3,'/categories '+GROUP));
  await f.entered.promise;
  await f.store.transaction(s=>{s.subscriptionRequirements.push({
   chatId:GROUP,channelIds:[CHANNEL],mode:'ALL',version:1
  });});
  f.membership.resolve('VERIFIED');
  const result=await pending;
  assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
  assert.equal((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds[0],CHANNEL);
 }finally{await f.close();}
});
test('B3 changed mandatory-channel configuration while membership request is pending denies stale access',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.subscriptionRequirements.push({
   chatId:GROUP,channelIds:[],mode:'ALL',version:1
  });});
  const pending=f.app.handle(msg(4,'/categories '+GROUP));
  await f.entered.promise;
  await f.store.transaction(s=>{s.subscriptionRequirements[0]!.mode='ANY';s.subscriptionRequirements[0]!.version++;});
  f.membership.resolve('VERIFIED');
  const result=await pending;
  assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
 }finally{await f.close();}
});
test('B3 group permissions revoked before lookup returns denial without calling external membership provider',async()=>{
 const f=await fixture();try{
  await f.policy.revokeChat(OWNER,GROUP);
  const r=await f.app.handle(msg(5,'/categories '+GROUP));
  assert.equal(r.status,'DENIED');assert.equal(r.reason,'CHAT_NOT_AUTHORIZED');
  assert.equal(r.plan,undefined);
 }finally{await f.close();}
});
test('B3 unchanged currently authorized group member can browse approved group category as before',async()=>{
 const f=await fixture();try{
  const pending=f.app.handle(msg(6,'/categories '+GROUP));
  await f.entered.promise;
  f.membership.resolve('VERIFIED');
  const r=await pending;
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/Secret Group Scholarship/);
  assert.equal((r.plan?.text??'').includes(CHANNEL),false);
 }finally{await f.close();}
});
