import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
const NOW=1700000000000,CHAT='-100123';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'command-review-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=0;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now),gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now);
  await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','301','chat.manage',CHAT,NOW+600000);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),moderation,clock:()=>now,botId:'command-review',botUsername:'ManaratakBot',ownerMenuMode:'inline',studentMenuMode:'inline',membership:async()=>{throw Error('UNEXPECTED_NETWORK');}});
  const command=(text='/ban case',actor=301)=>app.handle({update_id:++id,message:{message_id:1000+id,chat:{id:Number(CHAT),type:'supergroup'},from:{id:actor,is_bot:false},text,reply_to_message:{message_id:10,chat:{id:Number(CHAT),type:'supergroup'},from:{id:300,is_bot:false}}}});
  const click=(data:string,actor=301,group=false)=>app.handle({update_id:++id,callback_query:{id:'review-'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},from:{id:999,is_bot:true}}}});
  return {store,policy,gateway,moderation,command,click,time:(v:number)=>{now=v;},now:()=>now,close:()=>rm(dir,{recursive:true,force:true})};
 }
 type Result=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['command']>>;
 const choose=(r:Result,letter='c')=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:'+letter+':'));assert.ok(b,JSON.stringify(r));return b.callback_data;};
 test(engine+' command previews privately, then confirms once through the existing ledger',async()=>{
  const f=await fixture();try{
   const p=await f.command();assert.equal(p.reason,'MODERATION_PREVIEW_ONLY');assert.equal(p.plan!.chatId,'301');assert.equal(p.plan!.editMessageId,undefined);assert.equal(f.gateway.calls.length,0);assert.equal((await f.store.snapshot()).moderationReasons.length,0);
   const route=choose(p);assert.equal((await f.click(route,302)).status,'DENIED');assert.equal((await f.click(route,301,true)).status,'DENIED');const r=await f.click(route);assert.equal(r.status,'APPLIED');assert.equal(r.plan!.chatId,'301');assert.equal(r.plan!.editMessageId,55);assert.equal(f.gateway.calls.length,1);assert.equal((await f.click(route)).status,'DENIED');assert.equal(f.gateway.calls.length,1);
   const snapshot=await f.store.snapshot();assert.equal(snapshot.moderationOperations[0]!.status,'CONFIRMED');assert.equal(snapshot.moderationOperations[0]!.attemptGateway,'SIMULATION');
  }finally{await f.close();}
 });
 test(engine+' cancellation, expiry and replaced preview prevent changes and stale queued delivery',async()=>{
  const f=await fixture();try{
   let p=await f.command(),route=choose(p);const old=p.deliveryKey!;assert.equal((await f.click(choose(p,'x'))).reason,'MODERATION_CANCELLED');assert.equal((await f.click(route)).status,'DENIED');let sends=0;const d=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sends++;return {status:'CONFIRMED',messageId:55};}},f.now);assert.equal((await d.dispatch(old)).status,'FAILED_CONFIRMED');assert.equal(sends,0);
   p=await f.command();route=choose(p);f.time(NOW+120000);assert.equal((await f.click(route)).status,'DENIED');f.time(NOW);
   p=await f.command();route=choose(p);await f.command('/mute other');assert.equal((await f.click(route)).status,'DENIED');assert.equal(f.gateway.calls.length,0);assert.equal((await f.store.snapshot()).moderationReasons.length,0);
   p=await f.command();route=choose(p);await f.click('pn:1:h');assert.equal((await f.click(route)).status,'DENIED');assert.equal((await d.dispatch(p.deliveryKey!)).status,'FAILED_CONFIRMED');
  }finally{await f.close();}
 });
 test(engine+' lost grants, protected target and changes during confirmation reads fail closed',async()=>{
  const f=await fixture();try{
   let p=await f.command(),route=choose(p);await f.store.transaction(s=>{s.grants[0]!.revoked=true;});assert.equal((await f.click(route)).status,'DENIED');await f.policy.grant('100','301','chat.manage',CHAT,NOW+600000);
   p=await f.command();f.gateway.protectedMembers.add(CHAT+':300');assert.equal((await f.click(choose(p))).status,'DENIED');f.gateway.protectedMembers.clear();
   p=await f.command();f.gateway.canRestrict=async()=>{await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'MANUAL',kind:'MUTE',reference:'independent',createdBy:'100',active:true});});return true;};assert.equal((await f.click(choose(p))).status,'DENIED');assert.equal(f.gateway.calls.length,0);assert.equal((await f.store.snapshot()).moderationReasons.some(r=>r.reference==='case'),false);
  }finally{await f.close();}
 });
 test(engine+' warnings and release require confirmation, while unknown outcomes cannot replay',async()=>{
  const f=await fixture();try{
   let p=await f.command('/warn warning');assert.equal((await f.store.snapshot()).warnings.length,0);await f.click(choose(p));assert.equal((await f.store.snapshot()).warnings[0]!.active,true);
   p=await f.command('/unwarn warning');assert.equal((await f.store.snapshot()).warnings[0]!.active,true);await f.click(choose(p));assert.equal((await f.store.snapshot()).warnings[0]!.active,false);
   p=await f.command('/mute mute');await f.click(choose(p));p=await f.command('/unmute mute');assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);f.gateway.outcome='UNKNOWN_OUTCOME';const r=await f.click(choose(p));assert.equal(r.status,'UNKNOWN');const sent=f.gateway.calls.length;assert.equal((await f.command('/unmute mute')).status,'DENIED');assert.equal(f.gateway.calls.length,sent);
  }finally{await f.close();}
 });
}
