import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {CaptchaService,captchaSource} from '../src/captcha.js';
import {CaptchaJoinNotices} from '../src/captcha-join-notices.js';
import {TelegramCaptchaOwner} from '../src/telegram-captcha-owner.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import type {TemporaryGroupSendResult,TemporaryGroupDeleteResult,TemporaryGroupNotice} from '../src/telegram-temporary-group-sender.js';

const NOW=1700000000000,G='-100123',OWNER='100';
const pick=(view:OwnerInlineScreen|null,label:string)=>{
 assert.ok(view);const b=view.keyboard.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(b,label);return b.callback_data;
};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'captcha-join-notice-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW,running=true,sendResult:TemporaryGroupSendResult={status:'CONFIRMED',messageId:404},
   deleteResult:TemporaryGroupDeleteResult='ACKNOWLEDGED';
  let duringSend:(()=>Promise<void>)|undefined;
  const sent:TemporaryGroupNotice[]=[],deleted:{chat:string;messageId:number}[]=[];
  const sender={
   async send(input:TemporaryGroupNotice,verify:()=>Promise<boolean>){
    if(!(await verify()))return {status:'NOT_SENT'} as const;
    sent.push(input);
    if(duringSend){const callback=duringSend;duringSend=undefined;await callback();}
    return sendResult;
   },
   async delete(chat:string,messageId:number,verify:()=>Promise<boolean>){
    if(!(await verify()))return 'NOT_SENT' as const;
    deleted.push({chat,messageId});return deleteResult;
   }
  };
  const policy=new Policy(store,OWNER,()=>now);
  await policy.approveChat(OWNER,G,['moderation','verification','navigation']);
  const captcha=new CaptchaService(store,policy,async()=> 'VERIFIED',()=>now);
  assert.equal(await captcha.configure(OWNER,G,{enabled:true,timeout:60,attempts:3},captchaSource(await store.snapshot())),true);
  const notices=new CaptchaJoinNotices(store,policy,captcha,sender,'ManaratakBot',()=>now,async()=>running);
  const enable=async()=>{assert.equal(await notices.configure(OWNER,G,true,notices.epoch(await store.snapshot(),G)),true);};
  const observe=async(update='b3-webhook:captcha-join:11',topicId?:number)=>{
   assert.equal(await captcha.observe(G,['300'],update,now),1);
   return notices.observe(G,['300'],update,now,topicId);
  };
  return {store,policy,captcha,notices,sent,deleted,enable,observe,now:()=>now,advance:(ms:number)=>{now+=ms;},
   stop:()=>{running=false;},start:()=>{running=true;},setSend:(v:TemporaryGroupSendResult)=>{sendResult=v;},
   setDelete:(v:TemporaryGroupDeleteResult)=>{deleteResult=v;},duringSend:(v:()=>Promise<void>)=>{duringSend=v;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' join link defaults off and cannot announce without explicit owner consent',async()=>{
  const f=await fixture();try{
   assert.equal(f.notices.policy(await f.store.snapshot(),G)?.enabled,false);
   assert.equal(await f.observe(),0);
   assert.equal((await f.notices.drain()).sent,0);
   assert.equal(f.sent.length,0);
  }finally{await f.close();}
 });
 test(engine+' a trusted CAPTCHA join emits one anonymous public link and deletes only its receipt after expiry',async()=>{
  const f=await fixture();try{
   await f.enable();assert.equal(await f.observe('b3-webhook:captcha-join:11',42),1);
   assert.deepEqual(await f.notices.drain(),{sent:1,unresolved:0});
   assert.equal(f.sent.length,1);
   assert.deepEqual(f.sent[0],{chatId:G,botUsername:'ManaratakBot',topicId:42,kind:'CAPTCHA'});
   assert.equal(await f.notices.observe(G,['300'],'b3-webhook:captcha-join:11',f.now(),42),0);
   assert.equal((await f.notices.drain()).sent,0);
   assert.equal((await f.notices.cleanup()).deleted,0);
   f.advance(60000);assert.deepEqual(await f.notices.cleanup(),{deleted:1,unresolved:0});
   assert.deepEqual(f.deleted,[{chat:G,messageId:404}]);
   assert.equal((await f.notices.cleanup()).deleted,0);
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.updateKey.endsWith(':delete-outcome')).length,1);
  }finally{await f.close();}
 });
 test(engine+' join notification is never issued for duplicate, stale, invalid or unchallenged joins',async()=>{
  const f=await fixture();try{
   await f.enable();
   assert.equal(await f.notices.observe(G,['300'],'b3-webhook:captcha-join:11',f.now()),0);
   assert.equal(await f.notices.observe(G,['300'],'bogus',f.now()),0);
   f.advance(31000);
   assert.equal(await f.notices.observe(G,['300'],'b3-webhook:captcha-join:11',NOW),0);
   assert.equal((await f.notices.drain()).sent,0);
  }finally{await f.close();}
 });
 test(engine+' a changed CAPTCHA policy or withdrawn notice consent cancels pending delivery',async()=>{
  for(const cause of ['captcha','notice'] as const){
   const f=await fixture();try{
    await f.enable();assert.equal(await f.observe(),1);
    if(cause==='captcha')assert.equal(await f.captcha.configure(OWNER,G,{enabled:true,timeout:120,attempts:3},captchaSource(await f.store.snapshot())),true);
    else assert.equal(await f.notices.configure(OWNER,G,false,f.notices.epoch(await f.store.snapshot(),G)),true);
    assert.equal((await f.notices.drain()).sent,0);
    assert.equal(f.sent.length,0);
   }finally{await f.close();}
  }
 });
 test(engine+' unknown delivery is terminal and is not retried after restart',async()=>{
  const f=await fixture();try{
   await f.enable();f.setSend({status:'UNKNOWN_OUTCOME'});assert.equal(await f.observe(),1);
   assert.equal((await f.notices.drain()).unresolved,1);
   assert.equal(f.sent.length,1);assert.equal((await f.notices.drain()).sent,0);
   const second=new CaptchaJoinNotices(new BotStore(f.store.file,{engine}),f.policy,f.captcha,{
    send:async()=>{throw Error('must not resend');},delete:async()=>{throw Error('must not delete');}
   },'ManaratakBot',()=>f.now(),async()=>true);
   assert.equal((await second.drain()).sent,0);
   f.advance(60000);assert.equal((await second.cleanup()).deleted,0);
  }finally{await f.close();}
 });
 test(engine+' an interrupted started attempt is quarantined and never resent',async()=>{
  const f=await fixture();try{
   await f.enable();assert.equal(await f.observe(),1);
   await f.store.transaction(s=>{const q=s.audit.find(a=>a.updateKey.startsWith('captcha:join-notice-job:'))!;s.audit.push({actorId:OWNER,updateKey:q.updateKey+':started',decision:'ALLOW',reason:'CAPTCHA_JOIN_NOTICE_STARTED',policyVersion:q.policyVersion,at:f.now()});});
   assert.equal((await f.notices.drain()).sent,0);
   assert.equal(f.sent.length,0);
   assert.equal((await f.notices.cleanup()).deleted,0);
  }finally{await f.close();}
 });
 test(engine+' unknown delete response is terminal and cannot trigger a second deletion',async()=>{
  const f=await fixture();try{
   await f.enable();await f.observe();await f.notices.drain();
   f.advance(60000);f.setDelete('UNKNOWN_OUTCOME');
   assert.equal((await f.notices.cleanup()).unresolved,1);
   assert.equal((await f.notices.cleanup()).deleted,0);
   assert.equal(f.deleted.length,1);
  }finally{await f.close();}
 });
 test(engine+' safety STOP blocks send and deletion without touching already acknowledged receipts',async()=>{
  const f=await fixture();try{
   await f.enable();await f.observe();f.stop();assert.equal((await f.notices.drain()).sent,0);
   f.start();assert.equal((await f.notices.drain()).sent,1);
   f.advance(60000);f.stop();assert.equal((await f.notices.cleanup()).deleted,0);
   f.start();assert.equal((await f.notices.cleanup()).deleted,1);
  }finally{await f.close();}
 });
 test(engine+' concurrent changes during delivery never authorize repeat or blind cleanup',async()=>{
  const f=await fixture();try{
   await f.enable();await f.observe();
   f.duringSend(async()=>{assert.equal(await f.notices.configure(OWNER,G,false,f.notices.epoch(await f.store.snapshot(),G)),true);});
   const outcome=await f.notices.drain();
   assert.equal(outcome.sent,0);assert.equal(outcome.unresolved,1);
   f.advance(60000);assert.equal((await f.notices.cleanup()).deleted,0);
   assert.equal(f.sent.length,1);
  }finally{await f.close();}
 });
 test(engine+' public CAPTCHA notices throttle rapid joins to one per group per minute',async()=>{
  const f=await fixture();try{
   await f.enable();
   assert.equal(await f.observe('b3-webhook:captcha-join:11'),1);
   assert.equal(await f.captcha.observe(G,['301'],'b3-webhook:captcha-join:12',f.now()),1);
   assert.equal(await f.notices.observe(G,['301'],'b3-webhook:captcha-join:12',f.now()),0);
   assert.equal((await f.store.snapshot()).audit.filter(a=>/^captcha:join-notice-job:[a-f0-9]{64}$/u.test(a.updateKey)).length,1);
   f.advance(61000);
   assert.equal(await f.captcha.observe(G,['302'],'b3-webhook:captcha-join:13',f.now()),1);
   assert.equal(await f.notices.observe(G,['302'],'b3-webhook:captcha-join:13',f.now()),1);
   assert.equal((await f.store.snapshot()).audit.filter(a=>/^captcha:join-notice-job:[a-f0-9]{64}$/u.test(a.updateKey)).length,2);
  }finally{await f.close();}
 });
 test(engine+' unrelated grant changes do not silently revoke the approved join link policy',async()=>{
  const f=await fixture();try{
   await f.enable();
   await f.store.transaction(s=>{s.grants.push({actor:'555',chatId:'-100456',capability:'education.navigate',grantedBy:'100',revoked:false,expiresAt:NOW+600000});});
   assert.equal(f.notices.policy(await f.store.snapshot(),G)?.enabled,true);
   assert.equal(await f.observe(),1);
  }finally{await f.close();}
 });
 test(engine+' owner menu uses preview, confirmation and stable proof for public link toggle',async()=>{
  const f=await fixture();try{
   const ui=new TelegramCaptchaOwner(f.store,f.policy,f.captcha,()=>f.now(),undefined,f.notices);
   const root=await ui.handle(OWNER,'mi:1:i:04:07'),edit=await ui.handle(OWNER,pick(root,G));
   assert.equal(f.notices.policy(await f.store.snapshot(),G)?.enabled,false);
   const preview=await ui.handle(OWNER,pick(edit,'تفعيل رابط البوت'));
   assert.match(preview!.text,/معاينة/u);assert.equal(f.notices.policy(await f.store.snapshot(),G)?.enabled,false);
   const confirm=pick(preview,'تأكيد');
   assert.ok(await ui.handle(OWNER,confirm));
   assert.equal(f.notices.policy(await f.store.snapshot(),G)?.enabled,true);
   const replay=await ui.handle(OWNER,confirm);assert.equal(replay,null);
   const refreshed=await ui.handle(OWNER,'mi:1:i:04:07'),edited=await ui.handle(OWNER,pick(refreshed,G)),off=await ui.handle(OWNER,pick(edited,'إيقاف رابط البوت'));
   assert.ok(await ui.handle(OWNER,pick(off,'تأكيد')));
   assert.equal(f.notices.policy(await f.store.snapshot(),G)?.enabled,false);
  }finally{await f.close();}
 });
}
