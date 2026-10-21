import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {FakeMembershipGateway,SubscriptionGate} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',STUDENT='300',GROUP='-100123',CHANNEL='-100234';
const msg=(id:number,ref:string)=>({update_id:id,message:{message_id:id,
 chat:{id:Number(STUDENT),type:'private'},from:{id:Number(STUDENT),is_bot:false},
 text:'/resource '+ref}});
function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(r=>{resolve=r;});
 return {resolve,promise};
}
async function setup(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-group-resource-gate-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','verification','publishing']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'Group grants',order:1});
 await store.transaction(s=>s.educationResources.push({
  id:'group-res',scope:GROUP,categoryId:'grants',title:'Private Group Scholarship',
  university:'University',cycle:'2026',degree:'Bachelor',seats:null,
  sourceImportId:'import',sourceLocator:'row',reviewedBy:OWNER,status:'PUBLISHED'
 }));
 const ref=await links.issue(OWNER,'group-res',Date.now()+600000);
 const membership=async()=> 'VERIFIED' as const;
 const provider=new FakeMembershipGateway();
 const mod=new FakeModerationGateway();
 const gate=new SubscriptionGate(store,policy,provider,new ModerationService(store,policy,mod));
 const app=(withSubscription=true)=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,botId:'bot-main',botUsername:'ManaratakBot',
  membership, ...(withSubscription?{subscription:gate}:{})
 });
 return {store,policy,education,links,ref,gate,provider,mod,app,membership,
  close:()=>rm(dir,{force:true,recursive:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': group-scoped /resource link requires ALL mandatory-channel membership, not only group membership',async()=>{
  const f=await setup(engine);try{
   await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.provider.set(CHANNEL,STUDENT,'NOT_MEMBER');
   const denied=await f.app().handle(msg(1,f.ref));
   assert.equal(denied.status,'DENIED');assert.equal(denied.reason,'RESOURCE_DENIED');
   assert.equal(denied.plan,undefined);
   f.provider.set(CHANNEL,STUDENT,'MEMBER');
   const allowed=await f.app().handle(msg(2,f.ref));
   assert.equal(allowed.status,'APPLIED');assert.match(allowed.plan?.text??'',/Private Group Scholarship/);
   assert.equal((allowed.plan?.text??'').includes(CHANNEL),false);
  }finally{await f.close();}
 });
}
test('B3 no configured subscription verifier denies access to group link when mandatory gate is active',async()=>{
 const f=await setup();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
  f.provider.set(CHANNEL,STUDENT,'MEMBER');
  const r=await f.app(false).handle(msg(10,f.ref));
  assert.equal(r.status,'DENIED');assert.equal(r.plan,undefined);
  assert.equal((await f.links.resolve(f.ref,STUDENT,f.membership)).status,'DENIED');
 }finally{await f.close();}
});
test('B3 unknown or unreachable required-channel membership is not mistaken for eligibility via resource link',async()=>{
 const f=await setup();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ANY');
  const unknown=await f.app().handle(msg(11,f.ref));
  assert.equal(unknown.status,'DENIED');assert.equal(unknown.plan,undefined);
  f.provider.verifiable=false;
  const unavailable=await f.app().handle(msg(12,f.ref));
  assert.equal(unavailable.status,'DENIED');assert.equal(unavailable.plan,undefined);
  assert.equal(f.mod.calls.length,0);
 }finally{await f.close();}
});
test('B3 group link without mandatory-channel rules remains usable for verified group member',async()=>{
 const f=await setup();try{
  const r=await f.app(false).handle(msg(13,f.ref));
  assert.equal(r.status,'APPLIED');assert.match(r.plan?.text??'',/Private Group Scholarship/);
 }finally{await f.close();}
});
test('B3 new mandatory-channel rule created during pending group membership denies old link if no verifier is configured',async()=>{
 const f=await setup();try{
  const entered=deferred<void>(),external=deferred<'VERIFIED'>();
  const request=f.links.resolve(f.ref,STUDENT,async()=>{entered.resolve();return external.promise;});
  await entered.promise;
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
  external.resolve('VERIFIED');
  assert.equal((await request).status,'DENIED');
 }finally{await f.close();}
});
test('B3 changed mandatory-channel requirement during external subscription verification invalidates result',async()=>{
 const f=await setup();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
  const entered=deferred<void>(),external=deferred<'MEMBER'>();
  const request=f.links.resolve(f.ref,STUDENT,f.membership,async()=>{
   entered.resolve();return external.promise;
  });
  await entered.promise;
  const v=(await f.store.snapshot()).subscriptionRequirements[0]!.version;
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ANY');
  assert.equal((await f.store.snapshot()).subscriptionRequirements[0]!.version,v+1);
  external.resolve('MEMBER');
  assert.equal((await request).status,'DENIED');
 }finally{await f.close();}
});
test('B3 group revoke/reapprove during pending membership always invalidates original link authorization',async()=>{
 const f=await setup('sqlite');try{
  const entered=deferred<void>(),external=deferred<'VERIFIED'>();
  const request=f.links.resolve(f.ref,STUDENT,async()=>{entered.resolve();return external.promise;});
  await entered.promise;
  await f.policy.revokeChat(OWNER,GROUP);
  await f.policy.approveChat(OWNER,GROUP,['navigation','verification','publishing']);
  external.resolve('VERIFIED');
  assert.equal((await request).status,'DENIED');
 }finally{await f.close();}
});
test('B3 changing published source to archived during pending subscription verification prevents stale group resource delivery',async()=>{
 const f=await setup();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
  const entered=deferred<void>(),external=deferred<'MEMBER'>();
  const request=f.links.resolve(f.ref,STUDENT,f.membership,async()=>{entered.resolve();return external.promise;});
  await entered.promise;
  await f.store.transaction(s=>{s.educationResources.find(r=>r.id==='group-res')!.status='ARCHIVED';});
  external.resolve('MEMBER');
  assert.equal((await request).status,'DENIED');
 }finally{await f.close();}
});
test('B3 direct group link provider exceptions never permit access or trigger moderation',async()=>{
 const f=await setup();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
  const result=await f.links.resolve(f.ref,STUDENT,f.membership,async()=>{
   throw Error('untrusted-provider-error-containing-secret');
  });
  assert.equal(result.status,'DENIED');assert.equal(f.mod.calls.length,0);
 }finally{await f.close();}
});
