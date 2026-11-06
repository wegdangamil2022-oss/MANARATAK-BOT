import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',
 SOURCE='-100123',TARGET='-100124',SUBJECT='45678',REVIEW='333333333333';
const BOT=123456789,TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
type Method='getChat'|'getChatMember';
function button(s:OwnerInlineScreen|null,fragment:string):string{
 assert.ok(s,'expected screen: '+fragment);
 const b=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(fragment));
 assert.ok(b,'button '+fragment+' missing in '+s.text);
 assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64);
 return b.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(opts:{remote?:boolean;sourceStatus?:string;targetStatus?:string;
  onCall?:(name:Method,n:number)=>Promise<void>|void}={}){
  let now=NOW,enabled=true,sequence=0;
  const calls:{name:Method;chat:string;user?:number}[]=[];
  const dir=await mkdtemp(join(tmpdir(),'network-remote-ui-'));
  const store=new BotStore(join(dir,'s.'+engine),{engine});
  const policy=new Policy(store,OWNER,()=>now);
  for(const id of [SOURCE,TARGET])
   await policy.approveChat(OWNER,id,['moderation','navigation']);
  await store.transaction(s=>{
   s.groupNetworks=[{id:NET,name:'شبكة السلامة',revision:1,
    createdBy:OWNER,updatedAt:now,
    members:s.chats.map(c=>({chatId:c.id,version:c.version}))}];
   s.networkWatchCases=[{id:'222222222222',networkId:NET,networkRevision:1,
    sourceChatId:SOURCE,sourceChatVersion:1,subjectId:SUBJECT,
    category:'SPAM',revision:2,status:'WATCHED',submittedBy:OWNER,
    submittedAt:now-200,reviewedBy:OWNER,reviewedAt:now-150}];
   s.networkSanctionReviews=[{id:REVIEW,caseId:'222222222222',caseRevision:2,
    networkId:NET,networkRevision:1,sourceChatId:SOURCE,sourceChatVersion:1,
    targetChatId:TARGET,targetChatVersion:1,subjectId:SUBJECT,kind:'BAN',
    status:'REVIEWED_ONLY',revision:2,requestedBy:OWNER,requestedAt:now-100,
    reviewedBy:OWNER,reviewedAt:now-50}];
  });
  const request=(async(url:string|URL|Request,init?:RequestInit)=>{
   const name=String(url).split('/').at(-1)! as Method;
   assert.ok(name==='getChat'||name==='getChatMember','unexpected Telegram API call: '+name);
   const body=JSON.parse(String(init?.body)) as {chat_id:string;user_id?:number};
   assert.ok(body.chat_id===SOURCE||body.chat_id===TARGET);
   calls.push({name,chat:body.chat_id,...(body.user_id===undefined?{}:{user:body.user_id})});
   sequence++;
   await opts.onCall?.(name,sequence);
   const source=body.chat_id===SOURCE;
   const value=name==='getChat'?
    {id:Number(body.chat_id),type:'supergroup'}:
    body.user_id===BOT?
     {status:'administrator',user:{id:BOT,is_bot:true},can_restrict_members:true}:
     {status:source?opts.sourceStatus??'kicked':opts.targetStatus??'member',
      user:{id:Number(SUBJECT),is_bot:false}};
   return new Response(JSON.stringify({ok:true,result:value}),{status:200,
    headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const safety=async()=>enabled;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,request,safety);
  const owner=new OwnerNetworkEditor(store,policy,()=>now,
   opts.remote===false?undefined:{gateway,safety});
  return {store,policy,gateway,owner,calls,setEnabled:(value:boolean)=>{enabled=value;},
   advance:(delta:number)=>{now+=delta;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-003 real read-only owner review uses independent one-shot consent, no mutations',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:sr:'+REVIEW),true);
   assert.equal(validOwnerNetworkRoute('nw:1:sr:BAD'),false);
   const detail=await f.owner.handle(OWNER,'nw:1:sd:'+REVIEW);
   const preview=await f.owner.handle(OWNER,button(detail,'فحص Telegram'));
   assert.match(preview?.text??'',/معاينة/u);
   assert.deepEqual(f.calls,[],'preview must not invoke Telegram');
   const confirm=button(preview,'تأكيد');
   assert.equal(await f.owner.handle('200',confirm),null);
   assert.equal(f.calls.length,0);
   const result=await f.owner.handle(OWNER,confirm);
   assert.match(result?.text??'',/رُصد|تم رصد/u);
   assert.match(result?.text??'',/لا.*عقوبة/u);
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   assert.deepEqual(f.calls.map(x=>x.name),
    Array.from({length:4},()=>['getChat','getChatMember','getChatMember','getChatMember']).flat());
   assert.equal(f.calls.every(x=>x.name!=='getChatMember'||[BOT,Number(SUBJECT)].includes(x.user!)),true);
   const state=await f.store.snapshot();
   assert.equal(state.networkSanctionReviews![0]!.status,'REVIEWED_ONLY');
   assert.equal(state.moderationOperations.length,0);
   assert.equal(state.moderationReasons.length,0);
   assert.equal(state.operations.length,0);
   assert.equal(state.telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 no remote gateway means read-only button and custom route are absent',async()=>{
  const f=await fixture({remote:false});try{
   const detail=await f.owner.handle(OWNER,'nw:1:sd:'+REVIEW);
   assert.equal(detail?.keyboard.inline_keyboard.flat().some(x=>x.text.includes('فحص Telegram')),false);
   assert.equal(await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW),null);
   assert.equal(f.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 disabled safety switch rejects remote preview and confirmation',async()=>{
  const f=await fixture();try{
   f.setEnabled(false);
   assert.equal(await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW),null);
   f.setEnabled(true);
   const preview=await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW);
   f.setEnabled(false);
   const denied=await f.owner.handle(OWNER,button(preview,'تأكيد'));
   assert.doesNotMatch(denied?.text??'',/رُصد/u);
   assert.equal(f.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 stale network or owner policy invalidates consent before remote calls',async()=>{
  const f=await fixture();try{
   const preview=await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW);
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal(await f.owner.handle(OWNER,button(preview,'تأكيد')),null);
   assert.equal(f.calls.length,0);
  }finally{await f.close();}
  const g=await fixture();try{
   const preview=await g.owner.handle(OWNER,'nw:1:sr:'+REVIEW);
   await g.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await g.owner.handle(OWNER,button(preview,'تأكيد')),null);
   assert.equal(g.calls.length,0);
  }finally{await g.close();}
 });
 test(engine+' NETWORK-003 local pending restriction, rejected review and expiry never read remotely',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{
    s.moderationOperations.push({id:'unresolved-'+engine,chatId:TARGET,
     memberId:SUBJECT,actorId:OWNER,kind:'BAN',reasonFingerprint:'x',
     policyVersion:1,status:'UNKNOWN_OUTCOME',createdAt:NOW-30});
   });
   assert.equal(await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW),null);
   assert.equal(f.calls.length,0);
  }finally{await f.close();}
  const g=await fixture();try{
   await g.store.transaction(s=>{const row=s.networkSanctionReviews![0]!;
    row.status='REJECTED';});
   assert.equal(await g.owner.handle(OWNER,'nw:1:sr:'+REVIEW),null);
   assert.equal(g.calls.length,0);
  }finally{await g.close();}
  const h=await fixture();try{
   const preview=await h.owner.handle(OWNER,'nw:1:sr:'+REVIEW);
   h.advance(121_000);
   assert.equal(await h.owner.handle(OWNER,button(preview,'تأكيد')),null);
   assert.equal(h.calls.length,0);
  }finally{await h.close();}
 });
 test(engine+' NETWORK-003 failed source proof cannot be presented as successful observation',async()=>{
  const f=await fixture({sourceStatus:'member'});try{
   const preview=await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW);
   const denied=await f.owner.handle(OWNER,button(preview,'تأكيد'));
   assert.match(denied?.text??'',/تعذر|لم تُثبت|غير متحقق/u);
   assert.doesNotMatch(denied?.text??'',/✅.*رُصد/u);
   assert.ok(f.calls.length>0);
   assert.equal(f.calls.some(c=>!['getChat','getChatMember'].includes(c.name)),false);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 concurrent click delivers only one read and no second examination',async()=>{
  const f=await fixture();try{
   const preview=await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW);
   const confirmation=button(preview,'تأكيد');
   const results=await Promise.all([
    f.owner.handle(OWNER,confirmation),f.owner.handle(OWNER,confirmation)]);
   assert.equal(results.filter(x=>x!==null).length,1);
   assert.equal(f.calls.length,16);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 revoked safety during awaited remote reads invalidates a positive report',async()=>{
  let turnOff:()=>void=()=>{};
  const f=await fixture({onCall:(_,n)=>{if(n===3)turnOff();}});try{
   turnOff=()=>f.setEnabled(false);
   const preview=await f.owner.handle(OWNER,'nw:1:sr:'+REVIEW);
   const response=await f.owner.handle(OWNER,button(preview,'تأكيد'));
   assert.doesNotMatch(response?.text??'',/✅.*رُصد/u);
   assert.match(response?.text??'',/توقف|غير متاح|أُلغي/u);
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
  }finally{await f.close();}
 });
}
