import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService,type MembershipStatus} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';

const OWNER='100',STUDENT='300',GROUP='-100555',CHANNEL='-100556';
const update=(id:number,text:string)=>({update_id:id,message:{
 message_id:id,from:{id:Number(STUDENT),is_bot:false},
 chat:{id:Number(STUDENT),type:'private'},text
}});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-private-dispatch-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'Group Secret Scholarship',order:1});
 await education.createCategory(OWNER,{id:'private-grants',scope:'private',title:'Public Private Navigation',order:1});
 await store.transaction(s=>{
  s.educationResources.push({id:'group_resource',scope:GROUP,categoryId:'grants',
   title:'Approved Group Resource',university:'University',cycle:'2027',
   degree:'Bachelor',seats:null,sourceImportId:'local_verified',
   sourceLocator:'fixture',reviewedBy:OWNER,status:'PUBLISHED'});
 });
 let member:MembershipStatus='VERIFIED';
 let lookup:()=>Promise<MembershipStatus>=async()=>member;
 const membership=async()=>lookup();
 const gateway=new FakeMembershipGateway();
 const subscription=new SubscriptionGate(store,policy,gateway,
  new ModerationService(store,policy,new FakeModerationGateway()));
 const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  membership,subscription,botId:'main',botUsername:'ManaratakBot'});
 const sent:string[]=[];
 const sender={send:async(plan:{chatId:string;text:string})=>{
  sent.push(plan.text);return {status:'CONFIRMED' as const,messageId:404};
 }};
 const dispatch=(withMembership=true,withSubscription=true,clock:()=>number=Date.now)=>
  new TelegramReplyDispatcher(store,policy,sender,clock,undefined,
   withSubscription?subscription:undefined,
   withMembership?membership:undefined);
 return {store,policy,education,app,subscription,gateway,dispatch,sent,
  setMember:(status:MembershipStatus)=>{member=status;},
  overrideMember:(cb:()=>Promise<MembershipStatus>)=>{lookup=cb;},
  close:()=>rm(dir,{force:true,recursive:true})};
}
for(const engine of ['json','sqlite'] as const){
 const queue=async(f:Awaited<ReturnType<typeof fixture>>,id:number,text='/categories '+GROUP)=>{
  const r=await f.app.handle(update(id,text));
  assert.equal(r.status,'APPLIED',r.reason);
  assert.ok(r.deliveryKey);
  return r.deliveryKey!;
 };
 test('B6 '+engine+': private group browse reply contains scoped proof, sends with fresh membership, then scrubs proof',async()=>{
  const f=await fixture(engine);try{
   const key=await queue(f,1800);
   const before=(await f.store.snapshot()).telegramReplyJobs?.[0];
   assert.equal(before?.privateGroupAccess?.scope,GROUP);
   assert.equal(before?.privateGroupAccess?.actorId,STUDENT);
   assert.match(before?.privateGroupAccess?.epoch??'',/^[a-f0-9]{64}$/);
   assert.equal((await f.dispatch().dispatch(key)).status,'CONFIRMED');
   assert.equal(f.sent.length,1);
   const after=(await f.store.snapshot()).telegramReplyJobs?.[0];
   assert.equal(after?.status,'SENT');
   assert.equal(after?.privateGroupAccess,undefined);
   assert.equal(after?.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': losing actual Telegram group membership after planning blocks private delivery',async()=>{
  const f=await fixture(engine);try{
   const key=await queue(f,1801);
   f.setMember('NOT_MEMBER');
   assert.equal((await f.dispatch().dispatch(key)).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.[0]?.privateGroupAccess,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': adding mandatory subscription after private group reply queued blocks even if channel member',async()=>{
  const f=await fixture(engine);try{
   const key=await queue(f,1802);
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.gateway.set(CHANNEL,STUDENT,'MEMBER');
   assert.equal((await f.dispatch().dispatch(key)).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': losing mandatory subscription after planning blocks private group resources',async()=>{
  const f=await fixture(engine);try{
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.gateway.set(CHANNEL,STUDENT,'MEMBER');
   const key=await queue(f,1803,'/resources '+GROUP+' grants');
   f.gateway.set(CHANNEL,STUDENT,'NOT_MEMBER');
   assert.equal((await f.dispatch().dispatch(key)).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': unpublishing group category after private browsing queued invalidates stale text',async()=>{
  const f=await fixture(engine);try{
   const key=await queue(f,1804);
   await f.education.setCategoryEnabled(OWNER,'grants',false);
   assert.equal((await f.dispatch().dispatch(key)).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': group revocation during dispatch membership wait cannot send private response',async()=>{
  const f=await fixture(engine);try{
   const key=await queue(f,1805);
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
   f.overrideMember(async()=>{entered();await held;return 'VERIFIED';});
   const pending=f.dispatch().dispatch(key);
   await started;
   await f.policy.revokeChat(OWNER,GROUP);
   release();
   assert.equal((await pending).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': missing membership verifier cannot dispatch an otherwise approved private group resource',async()=>{
  const f=await fixture(engine);try{
   const key=await queue(f,1806);
   assert.equal((await f.dispatch(false).dispatch(key)).status,'FAILED_CONFIRMED');
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': normal private-scope navigation stays backward compatible',async()=>{
  const f=await fixture(engine);try{
   const key=await queue(f,1807,'/categories private');
   const row=(await f.store.snapshot()).telegramReplyJobs?.[0];
   assert.equal(row?.privateGroupAccess,undefined);
   f.setMember('NOT_MEMBER');
   assert.equal((await f.dispatch(false,false).dispatch(key)).status,'CONFIRMED');
   assert.equal(f.sent.length,1);
  }finally{await f.close();}
 });
 test('B6 '+engine+': invalid private group witness cannot be stored in JSON or SQLite',async()=>{
  const f=await fixture(engine);try{
   await queue(f,1808);
   const current=await f.store.snapshot();
   for(const value of [null,'fake',{actorId:'0',scope:GROUP,epoch:'0'.repeat(64),expiresAt:1},
    {actorId:STUDENT,scope:'private',epoch:'0'.repeat(64),expiresAt:1},
    {actorId:STUDENT,scope:GROUP,epoch:'x',expiresAt:1}]){
    await assert.rejects(f.store.transaction(s=>{
     (s.telegramReplyJobs?.[0] as unknown as Record<string,unknown>).privateGroupAccess=value;
    }),/Unsupported state schema/);
    assert.deepEqual(await f.store.snapshot(),current);
   }
  }finally{await f.close();}
 });
}
