import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {CaptchaService,captchaSource} from '../src/captcha.js';
import {CaptchaEscalationPolicy} from '../src/captcha-escalation-policy.js';
import {TelegramCaptchaOwner} from '../src/telegram-captcha-owner.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const NOW=1700000000000,G='-100123',OWNER='100',KEY='b3-webhook:captcha-escalation:10';
const button=(view:OwnerInlineScreen|null,label:string)=>{assert.ok(view);const b=view.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));assert.ok(b,label);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'captcha-escalation-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;
  const policy=new Policy(store,OWNER,()=>now);await policy.approveChat(OWNER,G,['moderation','verification','navigation']);
  const membership=async()=> 'VERIFIED' as const,captcha=new CaptchaService(store,policy,membership,()=>now);
  assert.equal(await captcha.configure(OWNER,G,{enabled:true,timeout:60,attempts:3},captchaSource(await store.snapshot())),true);
  const escalation=new CaptchaEscalationPolicy(store,policy,captcha,()=>now);
  const enabled=async()=>assert.equal(await escalation.configure(OWNER,G,'EXTENDED',escalation.epoch(await store.snapshot(),G)),true);
  const joined=async()=>{assert.equal(await captcha.observe(G,['300'],KEY,now),1);return captcha.challenge(await store.snapshot(),G,'300')!;};
  return {dir,store,policy,captcha,escalation,membership,enabled,joined,now:()=>now,advance:(n:number)=>{now+=n;},clock:()=>now,
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' escalation is STANDARD until a separate owner decision',async()=>{const f=await fixture();try{
  assert.equal(f.escalation.mode(await f.store.snapshot(),G),'STANDARD');
  const first=await f.joined();f.advance(60000);
  const screen=await f.captcha.view('300','cp:1:o:'+first.nonce);
  assert.match(screen!.text,/60 ثانية/u);
  assert.equal((await f.store.snapshot()).audit.filter(a=>a.updateKey.startsWith('captcha:escalation-used:')).length,0);
 }finally{await f.close();}});
 test(engine+' EXTENDED escalation graduates from a 3-minute to a 10-minute cooldown then human review',async()=>{const f=await fixture();try{
  await f.enabled();const first=await f.joined();f.advance(60000);
  let view=await f.captcha.view('300','cp:1:o:'+first.nonce);
  assert.match(view!.text,/180 ثانية/u);
  f.advance(180000);
  const second=await f.captcha.view('300','cp:1:r:'+first.nonce);
  assert.match(second!.text,/الاختبار/u);
  const round2=f.captcha.challenge(await f.store.snapshot(),G,'300')!;assert.notEqual(round2.nonce,first.nonce);
  f.advance(60000);view=await f.captcha.view('300','cp:1:o:'+round2.nonce);
  assert.match(view!.text,/600 ثانية/u);
  f.advance(600000);
  assert.ok(await f.captcha.view('300','cp:1:r:'+round2.nonce));
  const round3=f.captcha.challenge(await f.store.snapshot(),G,'300')!;
  f.advance(60000);
  view=await f.captcha.view('300','cp:1:o:'+round3.nonce);
  assert.match(view!.text,/المراجعة البشرية/u);
  assert.equal(f.captcha.reviewCases(await f.store.snapshot(),OWNER).length,1);
  assert.equal((await f.store.snapshot()).audit.filter(a=>a.updateKey.startsWith('captcha:escalation-used:')).length,3);
 }finally{await f.close();}});
 test(engine+' escalation policy change does not retroactively modify an already issued retry or award access',async()=>{const f=await fixture();try{
  await f.enabled();const issued=await f.joined();f.advance(60000);
  assert.match((await f.captcha.view('300','cp:1:o:'+issued.nonce))!.text,/180 ثانية/u);
  assert.equal(await f.escalation.configure(OWNER,G,'STANDARD',f.escalation.epoch(await f.store.snapshot(),G)),true);
  assert.match((await f.captcha.view('300','cp:1:o:'+issued.nonce))!.text,/180 ثانية/u);
  f.advance(60000);
  const tooEarly=await f.captcha.view('300','cp:1:r:'+issued.nonce);
  assert.match(tooEarly!.text,/120 ثانية/u);
  assert.equal(f.captcha.challenge(await f.store.snapshot(),G,'300')?.nonce,issued.nonce);
  f.advance(120000);assert.ok(await f.captcha.view('300','cp:1:r:'+issued.nonce));
  const newRound=f.captcha.challenge(await f.store.snapshot(),G,'300')!;
  f.advance(60000);assert.match((await f.captcha.view('300','cp:1:o:'+newRound.nonce))!.text,/120 ثانية/u);
 }finally{await f.close();}});
 test(engine+' damaged extended-session receipt cannot authorize an altered timer or CAPTCHA success',async()=>{const f=await fixture();try{
  await f.enabled();await f.joined();
  await f.store.transaction(s=>{const a=s.audit.find(x=>x.updateKey.startsWith('captcha:escalation-used:'))!;a.reason='tampered';});
  assert.equal(f.captcha.status(await f.store.snapshot(),G,'300'),'UNAVAILABLE');
  assert.equal(await f.captcha.view('300'),null);
 }finally{await f.close();}});
 test(engine+' extended session survives store reopening and cannot be mistaken for a fresh shorter cooldown',async()=>{const f=await fixture();try{
  await f.enabled();const first=await f.joined();f.advance(60000);
  const reopened=new CaptchaService(new BotStore(f.store.file,{engine}),f.policy,f.membership,f.clock);
  assert.match((await reopened.view('300','cp:1:o:'+first.nonce))!.text,/180 ثانية/u);
  const tooEarly=await reopened.view('300','cp:1:r:'+first.nonce);
  assert.match(tooEarly!.text,/180 ثانية/u);
  assert.equal(reopened.challenge(await f.store.snapshot(),G,'300')?.nonce,first.nonce);
 }finally{await f.close();}});
 test(engine+' stale owner approval and unrelated group changes cannot arm escalation',async()=>{const f=await fixture();try{
  const epoch=f.escalation.epoch(await f.store.snapshot(),G);
  await f.store.transaction(s=>{s.chats.find(x=>x.id===G)!.version++;});
  assert.equal(await f.escalation.configure(OWNER,G,'EXTENDED',epoch),false);
  // The old challenge configuration also belongs to the previous group approval.
  // Reapprove it explicitly before attempting a new escalation consent.
  assert.equal(await f.captcha.configure(OWNER,G,{enabled:true,timeout:60,attempts:3},
   captchaSource(await f.store.snapshot())),true);
  await f.policy.approveChat(OWNER,'-100987',['moderation']);
  const current=f.escalation.epoch(await f.store.snapshot(),G);
  assert.equal(await f.escalation.configure(OWNER,G,'EXTENDED',current),true);
 }finally{await f.close();}});
 test(engine+' escalation owner UI previews extended cooldown and confirms independently',async()=>{const f=await fixture();try{
  const ui=new TelegramCaptchaOwner(f.store,f.policy,f.captcha,f.clock,undefined,undefined,undefined,f.escalation);
  let root=await ui.handle(OWNER,'mi:1:i:04:07'),edit=await ui.handle(OWNER,button(root,G));
  const preview=await ui.handle(OWNER,button(edit,'تفعيل التدرج المتقدم'));
  assert.match(preview!.text,/3 دقائق/u);
  const confirm=button(preview,'تأكيد');
  assert.ok(await ui.handle(OWNER,confirm));
  assert.equal(f.escalation.mode(await f.store.snapshot(),G),'EXTENDED');
  assert.equal(await ui.handle(OWNER,confirm),null);
  root=await ui.handle(OWNER,'mi:1:i:04:07');edit=await ui.handle(OWNER,button(root,G));
  assert.match(edit!.text,/مفعل/u);
  const off=await ui.handle(OWNER,button(edit,'إيقاف التدرج المتقدم'));
  assert.ok(await ui.handle(OWNER,button(off,'تأكيد')));
  assert.equal(f.escalation.mode(await f.store.snapshot(),G),'STANDARD');
 }finally{await f.close();}});
}
