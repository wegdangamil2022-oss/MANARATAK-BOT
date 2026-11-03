import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {CaptchaService,captchaSource} from '../src/captcha.js';
import {CaptchaRuleGate} from '../src/captcha-rules.js';
import {TelegramGroupRules} from '../src/telegram-group-rules.js';
import {TelegramCaptchaOwner} from '../src/telegram-captcha-owner.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const NOW=1700000000000,GROUP='-100123';
const pick=(screen:OwnerInlineScreen|null,label:string)=>{assert.ok(screen);const button=screen.keyboard.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(button,label);return button.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'captcha-rules-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,member=true,hook=async()=>{};
  const clock=()=>now,policy=new Policy(store,'100',clock);await policy.approveChat('100',GROUP,['moderation','navigation','verification']);
  const membership=async()=>{await hook();return member?'VERIFIED' as const:'NOT_MEMBER' as const;},captcha=new CaptchaService(store,policy,membership,clock),gate=new CaptchaRuleGate(store,policy,captcha,membership,clock),rules=new TelegramGroupRules(store,policy,clock);
  await captcha.configure('100',GROUP,{enabled:true,timeout:60,attempts:3},captchaSource(await store.snapshot()));
  const publish=async(text:string)=>{const p=await rules.preview('100','/setrules '+GROUP+'\n'+text);assert.ok(p);assert.ok(await rules.handle('100',pick(p,'اعتماد الإصدار')));};
  await publish('احترام <الأعضاء>');
  const configure=async(enabled=true)=>{const before=await store.snapshot(),epoch=gate.epoch(before,GROUP),ref='captcha-owner:abcdefghijklmnopqrstuvwx';await store.transaction(s=>{s.callbacks=s.callbacks.filter(c=>c.ref!==ref);s.callbacks.push({ref,actorId:'100',chatId:'private',policyVersion:0,oneShot:true,used:true,revoked:false,expiresAt:now+120000,action:JSON.stringify([{kind:enabled?'rules-on-confirm':'rules-off-confirm',group:GROUP,page:0,settings:{enabled:true,timeout:60,attempts:3}},captchaSource(s),epoch])});});return gate.configure('100',GROUP,enabled,epoch,ref);};
  const pass=async()=>{await captcha.observe(GROUP,['300'],'b3-webhook:bot:1',now);const view=await captcha.view('300');assert.ok(await captcha.view('300',pick(view,'تحقق بديل')));};
  return {store,policy,captcha,gate,publish,configure,pass,clock,advance:(ms:number)=>{now+=ms;},leave:()=>{member=false;},hook:(f:()=>Promise<void>)=>{hook=f;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' current rules require actor-bound acceptance only after CAPTCHA passes',async()=>{const f=await fixture();try{
  assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'NOT_REQUIRED');assert.equal(await f.configure(),true);
  assert.equal(await f.gate.open('300',GROUP),null);await f.pass();assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'PENDING');
  const screen=await f.gate.open('300',GROUP);assert.match(screen!.text,/احترام &lt;الأعضاء&gt;/u);const confirm=pick(screen,'أوافق');assert.equal(await f.gate.accept('301',confirm),false);assert.equal(await f.gate.accept('300',confirm),true);assert.equal(await f.gate.accept('300',confirm),false);assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'ACCEPTED');
  await f.publish('القانون المعدل');assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'PENDING');const current=await f.gate.open('300',GROUP);assert.match(current!.text,/القانون المعدل/u);assert.equal(await f.gate.accept('300',pick(current,'أوافق')),true);
 }finally{await f.close();}});
 test(engine+' stale rules, revoked scope and missing membership cannot accept',async()=>{for(const change of ['rules','scope','member','race','expiry','extended','late-read'] as const){const f=await fixture();try{
  assert.equal(await f.configure(),true);await f.pass();const view=await f.gate.open('300',GROUP),button=pick(view,'أوافق');
  if(change==='rules')await f.publish('قانون جديد');if(change==='scope')await f.policy.revokeChat('100',GROUP);if(change==='member')f.leave();if(change==='expiry')f.advance(120000);if(change==='race')f.hook(async()=>{f.hook(async()=>{});await f.publish('تغيير أثناء فحص العضوية');});if(change==='extended')f.hook(async()=>{f.hook(async()=>{});await f.store.transaction(s=>{s.callbacks.find(c=>c.ref.startsWith('captcha-rules:'))!.expiresAt++;});});if(change==='late-read')f.hook(async()=>{f.hook(async()=>{});f.advance(120000);});
  assert.equal(await f.gate.accept('300',button),false);assert.ok(!(await f.store.snapshot()).audit.some(a=>a.updateKey.startsWith('captcha:rules-accepted:')));
 }finally{await f.close();}}});
 test(engine+' a stale membership read cannot open a rules acceptance screen',async()=>{const f=await fixture();try{
  assert.equal(await f.configure(),true);await f.pass();f.hook(async()=>{f.hook(async()=>{});f.advance(120000);});assert.equal(await f.gate.open('300',GROUP),null);assert.ok(!(await f.store.snapshot()).callbacks.some(c=>c.ref.startsWith('captcha-rules:')));
 }finally{await f.close();}});
 test(engine+' an obsolete rules button cannot trigger another membership lookup',async()=>{const f=await fixture();try{
  assert.equal(await f.configure(),true);await f.pass();const button=pick(await f.gate.open('300',GROUP),'أوافق');await f.publish('قانون أحدث');let reads=0;f.hook(async()=>{reads++;});assert.equal(await f.gate.accept('300',button),false);assert.equal(reads,0);
 }finally{await f.close();}});
 test(engine+' policy requires the owner confirmation and a current published rules version',async()=>{const f=await fixture();try{
  const state=await f.store.snapshot(),epoch=f.gate.epoch(state,GROUP);assert.equal(await f.gate.configure('301',GROUP,true,epoch,'captcha-owner:abcdefghijklmnopqrstuvwx'),false);
  assert.equal(await f.configure(),true);await f.store.transaction(s=>{const a=s.audit.find(a=>a.updateKey==='captcha:rules-policy:'+GROUP)!;a.reason='malformed';});assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'UNAVAILABLE');
 }finally{await f.close();}});
 test(engine+' owner enables required rules through a separate preview, confirmation and cancel',async()=>{const f=await fixture();try{
  const ui=new TelegramCaptchaOwner(f.store,f.policy,f.captcha,f.clock),root=await ui.handle('100','mi:1:i:04:07'),edit=await ui.handle('100',pick(root,GROUP)),preview=await ui.handle('100',pick(edit,'تفعيل موافقة القوانين'));assert.match(preview!.text,/معاينة/u);assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'NOT_REQUIRED');assert.equal(await ui.handle('301',pick(preview,'تأكيد')),null);
  assert.ok(await ui.handle('100',pick(preview,'إلغاء')));assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'NOT_REQUIRED');
  const root2=await ui.handle('100','mi:1:i:04:07'),edit2=await ui.handle('100',pick(root2,GROUP)),preview2=await ui.handle('100',pick(edit2,'تفعيل موافقة القوانين'));assert.ok(await ui.handle('100',pick(preview2,'تأكيد')));assert.notEqual(f.gate.status(await f.store.snapshot(),GROUP,'300'),'NOT_REQUIRED');
 }finally{await f.close();}});
 test(engine+' changing the published rules invalidates an owner confirmation before enabling',async()=>{const f=await fixture();try{
  const ui=new TelegramCaptchaOwner(f.store,f.policy,f.captcha,f.clock),root=await ui.handle('100','mi:1:i:04:07'),edit=await ui.handle('100',pick(root,GROUP)),preview=await ui.handle('100',pick(edit,'تفعيل موافقة القوانين')),confirm=pick(preview,'تأكيد');await f.publish('قانون محدث');assert.equal(await ui.handle('100',confirm),null);assert.equal(f.gate.status(await f.store.snapshot(),GROUP,'300'),'NOT_REQUIRED');
 }finally{await f.close();}});
 test(engine+' pending rule groups rotate after restart without starving later groups',async()=>{const f=await fixture();try{
  const groups=Array.from({length:9},(_,i)=>'-10020'+i);f.gate.pendingGroups=()=>groups;const first=await f.gate.pendingBatch('300');assert.equal(first.length,8);assert.ok(!first.includes(groups[8]!));
  const reopened=new CaptchaRuleGate(new BotStore(f.store.file,{engine}),f.policy,f.captcha,async()=> 'VERIFIED',f.clock);reopened.pendingGroups=()=>groups;const second=await reopened.pendingBatch('300');assert.equal(second.length,8);assert.ok(second.includes(groups[8]!));
  await f.store.transaction(s=>{s.audit.find(a=>a.updateKey==='captcha:rules-cursor:300')!.reason='-1';});assert.deepEqual(await reopened.pendingBatch('300'),[]);
 }finally{await f.close();}});
}
