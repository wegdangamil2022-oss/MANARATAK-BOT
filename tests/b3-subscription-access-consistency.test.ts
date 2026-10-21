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
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {FakeMembershipGateway,SubscriptionGate} from '../src/subscription.js';
import {FakeModerationGateway,ModerationService} from '../src/moderation.js';

const OWNER='100',STUDENT='300',GROUP='-100123',CHANNEL='-100234';
const message=(id:number,actor:string,text:string,group=false)=>({
 update_id:id,message:{message_id:id,from:{id:Number(actor),is_bot:false},
 chat:{id:group?Number(GROUP):Number(actor),type:group?'supergroup':'private'},text}
});
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-subscription-access-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','verification','publishing']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'Private grants',order:1});
 await store.transaction(s=>s.educationResources.push({
  id:'one',scope:GROUP,categoryId:'grants',title:'GROUP_SECRET_SCHOLARSHIP',
  university:'University',cycle:'2026',degree:'Bachelor',seats:null,
  sourceImportId:'import',sourceLocator:'row',reviewedBy:OWNER,status:'PUBLISHED'
 }));
 const ref=await links.issue(OWNER,'one',Date.now()+600000);
 const membership=async()=> 'VERIFIED' as const;
 const member=new FakeMembershipGateway();
 const gate=new SubscriptionGate(store,policy,member,
  new ModerationService(store,policy,new FakeModerationGateway()));
 const app=(subscription?:SubscriptionGate)=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,membership,
  botId:'bot-main',botUsername:'ManaratakBot',...(subscription?{subscription}:{})
 });
 return {store,policy,links,ref,gate,member,membership,app,
  close:()=>rm(dir,{recursive:true,force:true})};
}
const spoofNotRequired={
 verify:async()=>({status:'NOT_REQUIRED' as const,channels:[]})
} as unknown as SubscriptionGate;
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': active required channels never accept NOT_REQUIRED as student link proof',async()=>{
  const f=await fixture(engine);try{
   await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
   const result=await f.links.resolve(f.ref,STUDENT,f.membership,
    async()=> 'NOT_REQUIRED');
   assert.equal(result.status,'DENIED');
  }finally{await f.close();}
 });
 test('B3 '+engine+': student group and private-group catalogue deny spurious NOT_REQUIRED',async()=>{
  const f=await fixture(engine);try{
   await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
   for(const [id,actor,command,group] of [
     [10,STUDENT,'/categories',true],
     [11,STUDENT,'/resources grants',true],
     [12,STUDENT,'/categories '+GROUP,false],
     [13,STUDENT,'/resources '+GROUP+' grants',false]
   ] as const){
    const result=await f.app(spoofNotRequired).handle(message(id,actor,command,group));
    assert.equal(result.status,'DENIED',command);
    assert.equal(result.plan,undefined,command);
   }
  }finally{await f.close();}
 });
}
test('B3 owner retains explicit owner exception under active mandatory channels',async()=>{
 const f=await fixture();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
  assert.equal((await f.links.resolve(f.ref,OWNER,f.membership,
   async()=> 'NOT_REQUIRED')).status,'FOUND');
  const r=await f.app(spoofNotRequired).handle(message(20,OWNER,'/categories '+GROUP));
  assert.equal(r.status,'APPLIED');
  assert.match(r.plan?.text??'',/Private grants/);
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+': structurally invalid zero-channel rule cannot masquerade as a paused rule',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:[],mode:'CORRUPT' as 'ALL',version:1
   }));
   assert.equal((await f.links.resolve(f.ref,STUDENT,f.membership)).status,'DENIED');
   for(const [id,command,group] of [
     [30,'/categories',true],
     [31,'/resources grants',true],
     [32,'/categories '+GROUP,false],
     [33,'/resources '+GROUP+' grants',false]
   ] as const){
    const r=await f.app().handle(message(id,STUDENT,command,group));
    assert.equal(r.status,'DENIED',command);
    assert.equal(r.plan,undefined,command);
   }
  }finally{await f.close();}
 });
}
test('B3 duplicate group rules are not interpreted using whichever record appears first',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.subscriptionRequirements.push(
   {chatId:GROUP,channelIds:[],mode:'ALL',version:1},
   {chatId:GROUP,channelIds:[CHANNEL],mode:'ANY',version:1}
  ));
  f.member.set(CHANNEL,STUDENT,'MEMBER');
  assert.equal((await f.gate.verify(GROUP,STUDENT)).status,'UNAVAILABLE');
  assert.equal((await f.links.resolve(f.ref,STUDENT,f.membership)).status,'DENIED');
  assert.equal((await f.app().handle(message(40,STUDENT,'/categories',true))).status,'DENIED');
  assert.equal((await f.app().handle(message(41,STUDENT,'/categories '+GROUP))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 correctly paused canonical subscription still permits verified group members',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>s.subscriptionRequirements.push({
   chatId:GROUP,channelIds:[],mode:'ALL',version:1
  }));
  assert.equal((await f.links.resolve(f.ref,STUDENT,f.membership)).status,'FOUND');
  const r=await f.app().handle(message(50,STUDENT,'/categories '+GROUP));
  assert.equal(r.status,'APPLIED');
  assert.match(r.plan?.text??'',/Private grants/);
 }finally{await f.close();}
});


test('B3 group response cannot use a once-valid membership result after owner pauses channels mid-verification',async()=>{
 const f=await fixture('sqlite');try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ALL');
  let entered!:()=>void,finish!:(status:'MEMBER')=>void;
  const started=new Promise<void>(r=>{entered=r;});
  const external=new Promise<'MEMBER'>(r=>{finish=r;});
  const fake={
   verify:async()=>{entered();return {status:await external,channels:[CHANNEL]};}
  } as unknown as SubscriptionGate;
  const pending=f.app(fake).handle(message(60,STUDENT,'/resources grants',true));
  await started;
  const chatRev=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
  const ruleRev=(await f.store.snapshot()).subscriptionRequirements[0]!.version;
  await f.policy.pauseSubscriptionAtRevision(OWNER,GROUP,chatRev,ruleRev);
  finish('MEMBER');
  const response=await pending;
  assert.equal(response.status,'DENIED');
  assert.equal(response.plan,undefined);
 }finally{await f.close();}
});
test('B3 real gate owner exemption is scoped to owner, while students still require verified channels',async()=>{
 const f=await fixture();try{
  await f.gate.configure(OWNER,GROUP,[CHANNEL],'ANY');
  assert.equal((await f.gate.verify(GROUP,OWNER)).status,'NOT_REQUIRED');
  assert.equal((await f.gate.verify(GROUP,STUDENT)).status,'UNAVAILABLE');
  assert.equal((await f.links.resolve(f.ref,OWNER,f.membership,
   async(scope,actor)=>(await f.gate.verify(scope,actor)).status)).status,'FOUND');
  assert.equal((await f.links.resolve(f.ref,STUDENT,f.membership,
   async(scope,actor)=>(await f.gate.verify(scope,actor)).status)).status,'DENIED');
 }finally{await f.close();}
});
