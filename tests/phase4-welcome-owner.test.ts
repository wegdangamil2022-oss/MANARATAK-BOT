import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4OwnerGreetingUI,validOwnerGreetingRoute} from '../src/phase4-welcome-owner.js';
import {Phase4GreetingService} from '../src/phase4-greeting-service.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
const owner='100',group='-100123',other='300';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-phase4-owner-'));
 const store=new BotStore(join(dir,engine==='json'?'state.json':'state.sqlite'),{engine}),policy=new Policy(store,owner);
 await policy.approveChat(owner,group,['navigation']);
 let now=1_000_000;
 const ui=new Phase4OwnerGreetingUI(store,policy,()=>now);
 const service=new Phase4GreetingService(store,policy);
 return {dir,store,policy,ui,service,advance:(v:number)=>{now+=v;},dispose:()=>rm(dir,{recursive:true,force:true})};
}
const findButton=(screen:Awaited<ReturnType<Phase4OwnerGreetingUI['handle']>>,prefix:string)=>{
 const value=screen?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));
 assert.ok(value,'missing button '+prefix);return value.callback_data;
};
for(const engine of ['json','sqlite'] as const){
 test('phase4 owner '+engine+': official welcome and autoreply buttons show group selectors',async()=>{
  const f=await fixture(engine);try{
   const a=await f.ui.handle(owner,'mi:1:i:09:01');
   const b=await f.ui.handle(owner,'mi:1:i:09:05');
   assert.equal(isValidTelegramInlineKeyboard(a?.keyboard),true);
   assert.equal(isValidTelegramInlineKeyboard(b?.keyboard),true);
   assert.equal(findButton(a,'p4w:1:g:'),'p4w:1:g:'+group);
   assert.equal(await f.ui.handle(other,'mi:1:i:09:01'),null);
  }finally{await f.dispose();}
 });
 test('phase4 owner '+engine+': two-step welcome activation preserves revisions and rejects replay',async()=>{
  const f=await fixture(engine);try{
   const before=await f.ui.handle(owner,'p4w:1:g:'+group);
   assert.match(before?.text??'',/OFF/);
   const preview=await f.ui.handle(owner,'p4w:1:p:'+group+':w');
   assert.match(preview?.text??'',/معاينة/);
   const callback=findButton(preview,'p4w:1:c:');
   assert.equal(validOwnerGreetingRoute(callback),true);
   const accepted=await f.ui.handle(owner,callback);
   assert.match(accepted?.text??'',/GROUP/);
   const saved=(await f.service.status(owner,group)).settings;
   assert.equal(saved?.revision,1);assert.equal(saved?.enabled,true);
   assert.equal(saved?.welcomeMode,'GROUP');
   await assert.rejects(f.ui.handle(owner,callback),/PHASE4_PREVIEW_EXPIRED/);
  }finally{await f.dispose();}
 });
 test('phase4 owner '+engine+': previews expire and cannot change anything',async()=>{
  const f=await fixture(engine);try{
   const preview=await f.ui.handle(owner,'p4w:1:p:'+group+':v');
   const callback=findButton(preview,'p4w:1:c:');
   f.advance(120_001);
   await assert.rejects(f.ui.handle(owner,callback),/PHASE4_PREVIEW_EXPIRED/);
   assert.equal((await f.service.status(owner,group)).settings,null);
  }finally{await f.dispose();}
 });
 test('phase4 owner '+engine+': welcome text and keyword rules require private preview confirmation',async()=>{
  const f=await fixture(engine);try{
   const greeting=await f.ui.handle(owner,'/welcometext '+group+' | أهلًا {العضو} في {اسم_المجموعة}');
   await f.ui.handle(owner,findButton(greeting,'p4w:1:c:'));
   assert.match((await f.service.status(owner,group)).settings?.templates[0]?.text??'',/أهلًا/);
   const rule=await f.ui.handle(owner,'/autoreplyadd '+group+' | WORD | منحة | يمكنك البحث في مكتبة منارتك');
   await f.ui.handle(owner,findButton(rule,'p4w:1:c:'));
   const s=(await f.service.status(owner,group)).settings;
   assert.equal(s?.revision,2);assert.equal(s?.replyRules.length,1);
   assert.equal(s?.replyRules[0]?.phrase,'منحة');
   assert.equal(s?.enabled,true);
  }finally{await f.dispose();}
 });
 test('phase4 owner '+engine+': invalid templates and forged callbacks fail closed',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.ui.handle(owner,'/welcometext '+group+' | {غير_موجود}'),/INVALID_GREETING_TEXT/);
   assert.equal(validOwnerGreetingRoute('p4w:1:c:bad'),false);
   assert.equal(await f.ui.handle(owner,'p4w:1:c:abcabcabcabc').catch(()=>null),null);
   const preview=await f.ui.handle(owner,'p4w:1:p:'+group+':w');
   await assert.rejects(f.ui.handle(owner,'p4w:1:c:ffffffffff00'),/PHASE4_PREVIEW_EXPIRED/);
   assert.ok(preview);
  }finally{await f.dispose();}
 });
}