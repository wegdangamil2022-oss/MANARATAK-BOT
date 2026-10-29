import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {ModerationPurgeService,FakePurgeGateway} from '../src/moderation-purge.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramBotApiPurgeGateway} from '../src/telegram-purge-gateway.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
const OWNER='100',CHAT='-100123',NOW=30*86400000;
const command=(id:number,actor=100)=>({update_id:id,message:{message_id:100,from:{id:actor,is_bot:false},chat:{id:Number(CHAT),type:'supergroup'},text:'/delete',
 reply_to_message:{text:'PRIVATE_MESSAGE_NOT_TO_STORE',message_id:10,date:(NOW-1000)/1000,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}}}});
const tap=(id:number,data:string,actor=100,group=false)=>({update_id:id,callback_query:{id:'delete_'+id,from:{id:actor,is_bot:false},data,
 message:{message_id:777,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}}}});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'reply-delete-'));
  const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,OWNER,()=>NOW),education=new EducationService(store,policy);
  await policy.approveChat(OWNER,CHAT,['moderation']);
  let time=NOW;
  const gateway=new FakePurgeGateway(),purge=new ModerationPurgeService(store,policy,gateway,()=>time);
  await purge.observe({chatId:CHAT,messageId:10,senderKind:'USER',senderId:'300',sentAt:NOW-1000,observedAt:NOW,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false});
  const app=(service=purge)=>new TelegramUpdateApplication({store,policy,education,purge:service,admin:new EducationAdminFacade(store,policy,education),faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
   botId:'delete-test',botUsername:'ManaratakBot',clock:()=>time,membership:async()=>{throw Error('unexpected membership');}});
  return {store,policy,purge,gateway,app,setTime:(n:number)=>{time=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('delete reply previews privately, confirms once and never exposes message text ('+engine+')',async()=>{
  const f=await fixture();try{
   const preview=await f.app().handle(command(1));
   assert.equal(preview.status,'APPLIED');assert.equal(preview.plan?.chatId,OWNER);
   assert.ok(isValidTelegramInlineKeyboard(preview.plan?.inlineMarkup));assert.equal(f.gateway.calls.length,0);
   const button=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   const confirmation=tap(2,button.callback_data);
   assert.equal((await f.app().handle(confirmation)).reason,'DELETE_REQUEST_ACKNOWLEDGED');
   assert.equal((await f.app().handle(confirmation)).status,'DUPLICATE');
   assert.equal((await f.app().handle(tap(3,button.callback_data))).status,'DENIED');
   assert.equal(f.gateway.calls.length,1);assert.equal(f.gateway.calls[0]?.messageId,10);
   assert.equal(JSON.stringify(await f.store.snapshot()).includes('PRIVATE_MESSAGE_NOT_TO_STORE'),false);
  }finally{await f.close();}
 });
 test('forged actor, group callbacks and revoked approval cannot confirm deletion ('+engine+')',async()=>{
  const f=await fixture();try{
   const preview=await f.app().handle(command(1));
   const button=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   assert.equal((await f.app().handle(tap(2,button.callback_data,200))).status,'DENIED');
   assert.equal((await f.app().handle(tap(3,button.callback_data,100,true))).status,'DENIED');
   await f.policy.revokeChat(OWNER,CHAT);
   assert.equal((await f.app().handle(tap(4,button.callback_data))).status,'DENIED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test('delegated staff can cancel their own private preview, and an expired preview cannot execute ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.grant(OWNER,'200','chat.manage',CHAT,NOW+3600000);
   const preview=await f.app().handle(command(1,200));
   assert.equal(preview.plan?.chatId,'200');
   const cancel=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:x:'))!;
   assert.equal((await f.app().handle(tap(2,cancel.callback_data,200))).reason,'DELETE_CANCELLED');
   const next=await f.app().handle(command(3,200));
   const confirm=next.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   f.setTime(NOW+600001);
   assert.equal((await f.app().handle(tap(4,confirm.callback_data,200))).status,'DENIED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test('unknown deletion is shown privately and old confirmation never retries ('+engine+')',async()=>{
  const f=await fixture();try{
   f.gateway.outcome='UNKNOWN_OUTCOME';
   const preview=await f.app().handle(command(1));
   const confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   const outcome=await f.app().handle(tap(2,confirm.callback_data));
   assert.equal(outcome.status,'UNKNOWN');assert.equal(outcome.plan?.chatId,OWNER);
   assert.match(outcome.plan?.text??'',/غير مؤكدة/);
   assert.equal((await f.app().handle(tap(3,confirm.callback_data))).status,'DENIED');
   assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });
 test('editing the reviewed filter invalidates an old confirmation ('+engine+')',async()=>{
  const f=await fixture();try{
   const preview=await f.app().handle(command(1));
   const confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   await f.store.transaction(s=>{s.purgeJobs[0]!.filter.limit=2;});
   assert.equal((await f.app().handle(tap(2,confirm.callback_data))).status,'DENIED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test('review binding is checked atomically if a writer changes it during confirmation ('+engine+')',async()=>{
  const f=await fixture();try{
   const preview=await f.app().handle(command(1));
   const confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   const original=f.purge.confirm.bind(f.purge);
   f.purge.confirm=async(actor,id,digest)=>{
    await f.store.transaction(s=>{s.purgeJobs[0]!.filter.limit=2;});
    return original(actor,id,digest);
   };
   assert.equal((await f.app().handle(tap(2,confirm.callback_data))).status,'DENIED');
   assert.equal(f.gateway.calls.length,0);
   assert.equal((await f.store.snapshot()).purgeJobs[0]?.status,'PREVIEW');
  }finally{await f.close();}
 });
 test('private confirmation reaches the exact Bot API delete request via the durable service ('+engine+')',async()=>{
  const f=await fixture();try{
   let deletes=0;
   const request=(async(url:string|URL|Request,init?:RequestInit)=>{
    const method=String(url).split('/').at(-1),body=JSON.parse(String(init?.body));
    let result:unknown;
    if(method==='getChatMember')result={status:'administrator',user:{id:123456789,is_bot:true},can_delete_messages:true};
    else{assert.equal(method,'deleteMessage');assert.deepEqual(body,{chat_id:CHAT,message_id:10});deletes++;result=true;}
    return new Response(JSON.stringify({ok:true,result}),{status:200,headers:{'content-type':'application/json'}});
   }) as typeof fetch;
   const service=new ModerationPurgeService(f.store,f.policy,new TelegramBotApiPurgeGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>true),()=>NOW);
   const preview=await f.app(service).handle(command(1));
   const confirm=preview.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   const result=await f.app(service).handle(tap(2,confirm.callback_data));
   assert.equal(result.reason,'DELETE_REQUEST_ACKNOWLEDGED');
   assert.equal(result.plan?.editMessageId,777);assert.equal(deletes,1);
   assert.equal((await f.store.snapshot()).purgeJobs[0]?.items[0]?.status,'ACKNOWLEDGED');
  }finally{await f.close();}
 });
 test('approved owner cleanup button opens actual previews and their confirmation path ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.app().handle(command(1));
   const home=await f.app().handle(tap(2,'mi:1:i:02:13'));
   assert.equal(home.status,'APPLIED');assert.match(home.plan?.text??'',/معاينات الحذف/);
   const selection=home.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pq:1:v:'))!;
   assert.ok(selection);
   const detail=await f.app().handle(tap(3,selection.callback_data));
   assert.equal(detail.status,'APPLIED');assert.equal(f.gateway.calls.length,0);
   const confirm=detail.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pd:1:c:'))!;
   assert.ok(confirm);
   assert.equal((await f.app().handle(tap(4,confirm.callback_data))).reason,'DELETE_REQUEST_ACKNOWLEDGED');
   assert.equal(f.gateway.calls.length,1);
   assert.equal((await f.app().handle(tap(5,selection.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(tap(6,'mi:1:i:02:13',200))).status,'DENIED');
  }finally{await f.close();}
 });
 test('cleanup list paginates and refuses out-of-range or malformed selectors ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.app().handle(command(1));
   await f.store.transaction(s=>{const job=s.purgeJobs[0]!;for(let i=0;i<8;i++)s.purgeJobs.push({...structuredClone(job),id:randomUUID()});});
   const first=await f.app().handle(tap(2,'mi:1:i:02:13'));
   const next=first.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.text==='➡️ التالي')!;
   assert.ok(next);
   const second=await f.app().handle(tap(3,next.callback_data));
   assert.match(second.plan?.text??'',/صفحة 2 من 2/);
   assert.ok(isValidTelegramInlineKeyboard(second.plan?.inlineMarkup));
   assert.equal((await f.app().handle(tap(4,'pq:1:p:999'))).status,'DENIED');
   assert.equal((await f.app().handle(tap(5,'pq:1:p:01'))).status,'DENIED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test('unobserved or protected reply cannot enter a delete preview ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{s.rollingMessageMeta[0]!.pinned=true;});
   assert.equal((await f.app().handle(command(1))).status,'DENIED');
   await f.store.transaction(s=>{s.rollingMessageMeta=[];});
   assert.equal((await f.app().handle(command(2))).status,'DENIED');
   assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
}
