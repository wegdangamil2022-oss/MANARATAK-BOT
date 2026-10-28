import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,rename,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {renderOwnerModerationEmergencyStatus} from '../src/telegram-inline-moderation-emergency.js';

const OWNER='100',CHAT='-100123',NOW=1_700_000_000_000;
const select=(update:number,actor:number,data='mi:1:i:02:16',group=false)=>({
 update_id:update,
 callback_query:{id:'emergency_'+update,from:{id:actor,is_bot:false},data,
  message:{message_id:777,from:{id:999,is_bot:true},
   chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}}
 }
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-emergency-owner-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 const flag=join(dir,'emergency-stop.flag');
 await writeFile(flag,'STOP\n',{mode:0o600});
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=(moderationSafetyFile?:string)=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',
  clock:()=>NOW,...(moderationSafetyFile?{moderationSafetyFile}:{})
 });
 return {store,policy,flag,dir,app,close:()=>rm(dir,{recursive:true,force:true})};
}
const allButtons=(result:{plan?:{inlineMarkup?:{inline_keyboard:readonly (readonly {text:string;callback_data:string}[])[]}}})=>
 result.plan?.inlineMarkup?.inline_keyboard.flat().map(x=>x.callback_data)??[];

for(const engine of ['json','sqlite'] as const){
 test('owner emergency screen reads independent STOP file and offers safe review navigation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['moderation','navigation']);
   const stateBefore=await f.store.snapshot();
   const stopBefore=await readFile(f.flag);
   const result=await f.app(f.flag).handle(select(1,100));
   assert.equal(result.status,'APPLIED');
   assert.equal(result.plan?.editMessageId,777);
   assert.match(result.plan?.text??'',/السجلات والطوارئ/);
   assert.match(result.plan?.text??'',/STOP/);
   assert.match(result.plan?.text??'',/سجل العقوبات/);
   assert.match(result.plan?.text??'',/مجهولة النتيجة: 0/);
   assert.match(result.plan?.text??'',/معلقة: 0/);
   assert.match(result.plan?.text??'',/العقوبات الحية غير موصولة/);
   assert.equal(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup),true);
   const buttons=allButtons(result);
   for(const route of ['mr:1:h','mp:1:h','mi:1:i:02:15','mi:1:s:02:1','mi:1:h'])
    assert.ok(buttons.includes(route),'missing review/status navigation '+route);
   assert.deepEqual(await f.store.snapshot(),stateBefore);
   assert.deepEqual(await readFile(f.flag),stopBefore);
   assert.equal((await f.app(f.flag).handle(select(2,300))).status,'DENIED');
   assert.equal((await f.app(f.flag).handle(select(3,100,'mi:1:i:02:16',true))).status,'DENIED');
  }finally{await f.close();}
 });
 test('RUN, missing and malformed emergency files never imply STOP or live sanction readiness ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const app=f.app(f.flag);
   await writeFile(f.flag,'RUN\n');
   const run=await app.handle(select(10,100));
   assert.equal(run.status,'APPLIED');
   assert.match(run.plan?.text??'',/RUN/);
   assert.match(run.plan?.text??'',/العقوبات الحية غير موصولة/);
   await writeFile(f.flag,'BROKEN\n');
   const corrupt=await app.handle(select(11,100));
   assert.equal(corrupt.status,'APPLIED');
   assert.match(corrupt.plan?.text??'',/غير موثوق/);
   assert.doesNotMatch(corrupt.plan?.text??'',/حالة المفتاح: STOP/);
   const notConfigured=await f.app().handle(select(12,100));
   assert.equal(notConfigured.status,'APPLIED');
   assert.match(notConfigured.plan?.text??'',/غير مهيأ/);
   assert.doesNotMatch(notConfigured.plan?.text??'',/حالة المفتاح: STOP/);
   const missing=await f.app(join(f.dir,'does-not-exist.flag')).handle(select(13,100));
   assert.match(missing.plan?.text??'',/غير موثوق/);
  }finally{await f.close();}
 });
 test('local unresolved moderation attempts are aggregated without exposing actors or members ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,CHAT,['moderation']);
   await f.store.transaction(s=>{
    const version=s.chats[0]!.version;
    for(const [i,status] of ['INTENT','STARTED','UNKNOWN_OUTCOME','CONFIRMED'] .entries()){
     s.moderationOperations.push({
      id:'PRIVATE_OPERATION_'+i,actorId:'555001',memberId:'666002',
      chatId:CHAT,kind:'BAN',reasonFingerprint:'PRIVATE_REASON',
      policyVersion:version,createdAt:NOW-1000,
      status:status as 'INTENT'|'STARTED'|'UNKNOWN_OUTCOME'|'CONFIRMED'
     });
    }
   });
   const snapshot=await f.store.snapshot();
   const output=await f.app(f.flag).handle(select(20,100));
   assert.equal(output.status,'APPLIED');
   assert.match(output.plan?.text??'',/مجهولة النتيجة: 1/);
   assert.match(output.plan?.text??'',/معلقة: 2/);
   assert.match(output.plan?.text??'',/بحاجة إلى مراجعة/);
   for(const secret of ['555001','666002','PRIVATE_OPERATION','PRIVATE_REASON',CHAT,f.dir])
    assert.equal((output.plan?.text??'').includes(secret),false,'sensitive detail leaked');
   assert.deepEqual(await f.store.snapshot(),snapshot);
  }finally{await f.close();}
 });
}
test('untrusted owner and invalid clock are denied before reading safety file or snapshot',async()=>{
 const f=await fixture('sqlite');try{
  const view=await renderOwnerModerationEmergencyStatus(
   f.store,f.policy,'200',NOW,join(f.dir,'missing.flag'));
  assert.equal(view,null);
  const invalid=await renderOwnerModerationEmergencyStatus(
   f.store,f.policy,OWNER,Number.NaN,f.flag);
  assert.equal(invalid,null);
 }finally{await f.close();}
});
test('owner can navigate review buttons from emergency panel, but cannot mutate via status page',async()=>{
 const f=await fixture('json');try{
  const app=f.app(f.flag);
  const status=await app.handle(select(30,100));
  assert.equal(status.status,'APPLIED');
  for(const [id,data] of [[31,'mr:1:h'],[32,'mp:1:h'],[33,'mi:1:i:02:15']] as const){
   const open=await app.handle(select(id,100,data));
   assert.equal(open.status,'APPLIED',data);
   assert.equal(open.plan?.editMessageId,777);
  }
  const initial=await f.store.snapshot();
  const replay=await app.handle(select(30,100));
  assert.equal(replay.status,'DUPLICATE');
  assert.deepEqual(await f.store.snapshot(),initial);
 }finally{await f.close();}
});

test('pending moderation navigation grammar is bounded and rejects fabricated detail selectors',()=>{
 const check=(callback_data:string)=>isValidTelegramInlineKeyboard({
  inline_keyboard:[[{text:'⏳ الحالة',callback_data}]]
 });
 assert.equal(check('mp:1:h'),true);
 assert.equal(check('mp:1:p:0'),true);
 assert.equal(check('mp:1:d:12:8:abcdef123456'),true);
 for(const bad of ['mp:1:p:01','mp:1:d:0:0:abcdef123456',
   'mp:1:d:0:9:abcdef123456','mp:1:d:0:1:PRIVATE_ID',
   'mp:1:d:0:1:abcdef123456:extra','mp:1:h\n','mp:2:h'])
  assert.equal(check(bad),false,bad);
});
