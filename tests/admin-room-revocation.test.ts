import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {AdminRoomLinks,adminRoomRevokeWitness} from '../src/admin-room-links.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {TelegramModerationReports} from '../src/telegram-moderation-reports.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {AdminRoomNoticeDispatcher,TelegramAdminRoomNoticeSender} from '../src/admin-room-notices.js';
const NOW=1700000000000;
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const button=(result:Result,prefix:string)=>{assert.equal(result.status,'APPLIED');assert.ok(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup));const b=result.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,prefix);return b.callback_data;};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'admin-room-revoke-')),path=join(dir,'state.'+engine);let now=NOW,update=0;
 const store=new BotStore(path,{engine}),policy=new Policy(store,'100',()=>now);
 for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);
 await policy.grant('100','301','chat.manage','-100',now+86400000);await policy.grant('100','302','chat.manage','-200',now+86400000);
 const links=new AdminRoomLinks(store,policy,()=>now);
 const activate=async(mode:'NOTIFICATIONS'|'CONTROL'|'CENTRAL')=>{const id=await links.propose('301','-100','-200',mode);assert.ok(id);await links.approve('301',id,'GROUP');assert.equal(await links.approve('302',id,'ROOM'),'ACTIVE');return id;};
 const id=await activate('NOTIFICATIONS');
 const app=()=>{const education=new EducationService(store,policy,()=>now);return new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),membership:async()=> 'VERIFIED',clock:()=>now,botId:'revoke-ui',botUsername:'ManaratakBot'});};
 const tap=(data:string,actor=302)=>{const n=++update;return app().handle({update_id:n,callback_query:{id:'revoke'+n,from:{id:actor,is_bot:false},data,message:{message_id:1,chat:{id:actor,type:'private'},from:{id:999,is_bot:true}}}});};
 const first=async()=>{const detail=await tap('al:1:d:'+id);return tap(button(detail,'al:1:x:'));};
 const second=async()=>tap(button(await first(),'al:1:z:'));
 return {store,policy,links,id,activate,tap,first,second,setNow:(at:number)=>{now=at;},now:()=>now,reopen:()=>new BotStore(path,{engine}),close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' two confirmations revoke only the selected mode, once, and survive application restart',async()=>{
  const f=await fixture(engine);try{
   await f.activate('CONTROL');await f.activate('CENTRAL');const first=await f.first(),firstRoute=button(first,'al:1:z:');assert.match(first.plan!.text,/التأكيد الأول/u);
   assert.equal(await f.links.isActive('-100','-200','NOTIFICATIONS'),true);const second=await f.tap(firstRoute),final=button(second,'al:1:w:');assert.match(second.plan!.text,/التأكيد الثاني/u);assert.equal(await f.links.isActive('-100','-200','NOTIFICATIONS'),true);
   assert.equal((await f.tap(firstRoute)).status,'DENIED');assert.equal((await f.tap(final,303)).status,'DENIED');
   const parallel=await Promise.all([f.tap(final),f.tap(final)]);assert.deepEqual(parallel.map(r=>r.status).sort(),['APPLIED','DENIED']);
   assert.equal(await f.links.isActive('-100','-200','NOTIFICATIONS'),false);assert.equal(await f.links.isActive('-100','-200','CONTROL'),true);assert.equal(await f.links.isActive('-100','-200','CENTRAL'),true);
   const restored=await f.reopen().snapshot();assert.equal(restored.audit.filter(a=>a.updateKey==='admin-room:request:'+f.id+':revoked').length,1);
   assert.equal((await f.tap(final)).status,'DENIED');assert.equal(JSON.stringify(restored).includes('ADMIN_ROOM_REVOKED'),true);
  }finally{await f.close();}
 });
 test(engine+' back navigation cancels either confirmation and invalidates queued screens',async()=>{
  const f=await fixture(engine);try{
   const first=await f.first(),firstRoute=button(first,'al:1:z:');await f.tap(button(first,'al:1:d:'));assert.equal((await f.tap(firstRoute)).status,'DENIED');
   const second=await f.second(),final=button(second,'al:1:w:');await f.tap(button(second,'al:1:d:'));assert.equal((await f.tap(final)).status,'DENIED');assert.equal(await f.links.isActive('-100','-200','NOTIFICATIONS'),true);
   let sends=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:10};}},f.now);
   assert.equal((await dispatcher.dispatch(second.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sends,0);
  }finally{await f.close();}
 });
 test(engine+' final confirmation expires at the original deadline and rejects clock rollback',async()=>{
  const f=await fixture(engine);try{
   const first=await f.first();f.setNow(NOW+119000);const second=await f.tap(button(first,'al:1:z:')),final=button(second,'al:1:w:');
   f.setNow(NOW+120000);assert.equal((await f.tap(final)).status,'DENIED');assert.equal(await f.links.isActive('-100','-200','NOTIFICATIONS'),true);
   f.setNow(NOW+121000);const fresh=await f.second(),rollback=button(fresh,'al:1:w:');f.setNow(NOW+120999);assert.equal((await f.tap(rollback)).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' a changed authorization cannot be restored to reuse an old confirmation',async()=>{
  const f=await fixture(engine);try{
   const second=await f.second(),final=button(second,'al:1:w:');await f.store.transaction(s=>{s.grants.find(g=>g.actor==='302')!.revoked=true;});
   assert.equal((await f.tap(final)).status,'DENIED');await f.policy.grant('100','302','chat.manage','-200',NOW+86400000);assert.equal((await f.tap(final)).status,'DENIED');
   assert.equal((await f.store.snapshot()).audit.some(a=>a.reason==='ADMIN_ROOM_REVOKED'),false);
  }finally{await f.close();}
 });
 test(engine+' revocation rechecks the witness and deadline inside its mutation transaction',async()=>{
  const f=await fixture(engine);try{
   const witness=adminRoomRevokeWitness(await f.store.snapshot(),f.policy,'302',f.id,NOW);assert.ok(witness);const expected={witness,createdAt:NOW,expiresAt:NOW+120000};
   f.setNow(NOW+120000);assert.equal(await f.links.revoke('302',f.id,expected),false);f.setNow(NOW-1);assert.equal(await f.links.revoke('302',f.id,expected),false);f.setNow(NOW);
   await f.store.transaction(s=>{s.grants.find(g=>g.actor==='302')!.expiresAt-=1000;});assert.equal(await f.links.revoke('302',f.id,expected),false);
   const fresh=adminRoomRevokeWitness(await f.store.snapshot(),f.policy,'302',f.id,NOW);assert.ok(fresh);assert.equal(await f.links.revoke('302',f.id,{...expected,witness:fresh}),true);
  }finally{await f.close();}
 });
 test(engine+' final UI revocation stops a queued notice while its privacy read is pending',async()=>{
  const f=await fixture(engine);let release!:()=>void;try{
   assert.equal(await new TelegramModerationReports(f.store,f.policy,f.now).submit('300','-100',101,{message_id:1,chat:{id:-100,type:'supergroup'},from:{id:400,is_bot:false}}),'RECORDED');
   const final=button(await f.second(),'al:1:w:');let started!:()=>void,posts=0;const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
   const request=(async(url:unknown)=>{if(String(url).endsWith('/getChat')){started();await gate;return Response.json({ok:true,result:{id:-200,type:'supergroup'}});}posts++;throw Error('revoked room must not receive a notice');}) as typeof fetch;
   const token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',worker=new AdminRoomNoticeDispatcher(f.store,f.policy,new TelegramBotApiModerationGateway(token,request),new TelegramAdminRoomNoticeSender(token,request),f.now,async()=>true);
   const draining=worker.drain();await entered;assert.equal((await f.tap(final)).status,'APPLIED');release();assert.equal(await draining,0);assert.equal(posts,0);assert.equal(await worker.drain(),0);
  }finally{release?.();await f.close();}
 });
 for(const variant of ['wrong-step','legacy','duplicate','extended'] as const)test(engine+' rejects '+variant+' revocation callbacks without changing the link',async()=>{
  const f=await fixture(engine);try{
   const final=button(await f.second(),'al:1:w:');
   if(variant==='wrong-step')assert.equal((await f.tap(final.replace('al:1:w:','al:1:z:'))).status,'DENIED');
   else{await f.store.transaction(s=>{const c=s.callbacks.find(c=>c.ref==='admin-room:revoke-preview:'+final.slice('al:1:w:'.length))!;if(variant==='legacy')c.action='admin-room:revoke-preview:'+f.id;if(variant==='duplicate')s.callbacks.push({...c});if(variant==='extended')c.expiresAt++;});assert.equal((await f.tap(final)).status,'DENIED');}
   assert.equal(await f.links.isActive('-100','-200','NOTIFICATIONS'),true);
  }finally{await f.close();}
 });
}
