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
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {parseOwnerInlineGroupRoute} from '../src/telegram-inline-groups.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {ownerGroupCardLink} from '../src/telegram-inline-groups.js';

const OWNER='100', GROUP='-100123';
const cb=(update:number,actor:number,data:string,kind:'private'|'supergroup'='private')=>({
 update_id:update,callback_query:{
  id:'group_'+update,from:{id:actor,is_bot:false},data,
  message:{message_id:57,chat:{id:kind==='private'?actor:Number(GROUP),type:kind},
   from:{id:999,is_bot:true}}
 }
});
const msg=(update:number,text:string)=>({
 update_id:update,message:{message_id:update,chat:{id:100,type:'private'},
 from:{id:100,is_bot:false},text}
});
const buttons=(response:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 response.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-inline-groups-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 return {store,policy,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('group callback grammar is canonical, bounded, versioned, and read-only',()=>{
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:p:0'),{kind:'list',page:0});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:d:-100123:4:0'),
  {kind:'details',chatId:'-100123',version:4,page:0});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:u:-100123:4:2'),
  {kind:'subscription',chatId:'-100123',version:4,page:2});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:a:-100123:4:2'),
  {kind:'access',chatId:'-100123',version:4,page:2});
 for(const invalid of ['mi:1:g:p:01','mi:1:g:p:1000','mi:1:g:d:-100123:0:0',
  'mi:1:g:d:-100123:04:0','mi:1:g:d:-100123:1:01','mi:1:g:d:-0:1:0',
  'mi:1:g:d:100123:1:0','mi:1:g:d:-100123:1:1000',
  'mi:1:g:d:-100123:1:0:confirm','mi:1:g:x:-100123:1:0',
  'mi:1:g:d:-100123:1:0\n','mi:1:g:p:-1','mi:2:g:p:0',
  'mi:1:g:d:-'+('9'.repeat(30))+':1:0']){
  assert.equal(parseOwnerInlineGroupRoute(invalid),null,invalid);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('inline approved groups: first page, details, local scopes/subscriptions and navigation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','assistant','moderation','verification']);
   await f.policy.setPresence(GROUP,true);
   await f.policy.configureGroupAI(OWNER,GROUP,'OWNER_MENTION');
   const version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   const list=await f.app().handle(cb(1,100,'mi:1:i:01:01'));
   assert.equal(list.status,'APPLIED');
   assert.match(list.plan?.text??'',/المجموعات المعتمدة/);
   assert.match(list.plan?.text??'',/محفوظ/);
   assert.equal(isValidTelegramInlineKeyboard(list.plan?.inlineMarkup),true);
   const detailsButton=buttons(list).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   assert.equal(detailsButton.callback_data,'mi:1:g:d:'+GROUP+':'+version+':0');
   const detail=await f.app().handle(cb(2,100,detailsButton.callback_data));
   assert.equal(detail.status,'APPLIED');
   assert.equal(detail.plan?.editMessageId,57);
   assert.match(detail.plan?.text??'',/navigation/);
   assert.match(detail.plan?.text??'',/OWNER_MENTION/);
   assert.match(detail.plan?.text??'',/لا.*تحقق حي/);
   const accessButton=buttons(detail).find(b=>b.callback_data.startsWith('mi:1:g:a:'))!;
   const access=await f.app().handle(cb(3,100,accessButton.callback_data));
   assert.equal(access.status,'APPLIED');
   assert.match(access.plan?.text??'',/moderation/);
   const subsButton=buttons(detail).find(b=>b.callback_data.startsWith('mi:1:g:u:'))!;
   const subs=await f.app().handle(cb(4,100,subsButton.callback_data));
   assert.equal(subs.status,'APPLIED');
   assert.match(subs.plan?.text??'',/الاشتراك/);
   assert.equal(buttons(subs).some(b=>b.callback_data===detailsButton.callback_data),true);
   const back=buttons(detail).find(b=>b.callback_data==='mi:1:g:p:0')!;
   const returned=await f.app().handle(cb(5,100,back.callback_data));
   assert.equal(returned.status,'APPLIED');
   assert.match(returned.plan?.text??'',/المجموعات المعتمدة/);
   assert.equal((await f.store.snapshot()).chats.find(c=>c.id===GROUP)?.approved,true);
   assert.equal((await f.store.snapshot()).chats.find(c=>c.id===GROUP)?.version,version);
  }finally{await f.close();}
 });
 test('inline group pagination survives 19 groups, rejects out-of-range and stale page members ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<19;i++)
    await f.policy.approveChat(OWNER,'-100'+String(1000+i),['navigation']);
   const first=await f.app().handle(cb(20,100,'mi:1:i:01:01'));
   assert.equal(buttons(first).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,8);
   const p1=await f.app().handle(cb(21,100,'mi:1:g:p:1'));
   assert.equal(p1.status,'APPLIED');
   assert.equal(buttons(p1).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,8);
   const p2=await f.app().handle(cb(22,100,'mi:1:g:p:2'));
   assert.equal(p2.status,'APPLIED');
   assert.equal(buttons(p2).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,3);
   const chosen=buttons(p2).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   const shifted=buttons(p1).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).at(-1)!;
   assert.equal((await f.app().handle(cb(23,100,chosen.callback_data))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(24,100,'mi:1:g:p:3'))).status,'DENIED');
   const wrongPage=chosen.callback_data.replace(/:2$/u,':0');
   assert.equal((await f.app().handle(cb(25,100,wrongPage))).status,'DENIED');
   // A newly approved chat can move the selected group out of its old page.
   await f.policy.approveChat(OWNER,'-1000999',['navigation']);
   assert.equal((await f.app().handle(cb(26,100,shifted.callback_data))).status,'DENIED');
  }finally{await f.close();}
 });
 test('inline group details fail closed after policy changes, revocation and foreign scope ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','verification']);
   const list=await f.app().handle(cb(30,100,'mi:1:g:p:0'));
   const original=buttons(list).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   assert.equal((await f.app().handle(cb(31,200,original.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(32,300,original.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(33,100,original.callback_data,'supergroup'))).status,'DENIED');
   const originalVersion=(await f.store.snapshot()).chats[0]!.version;
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.app().handle(cb(34,100,original.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(35,100,original.callback_data.replace(':d:',':a:')))).status,'DENIED');
   assert.equal((await f.app().handle(cb(36,100,original.callback_data.replace(':d:',':u:')))).status,'DENIED');
   const next=await f.app().handle(cb(37,100,'mi:1:g:p:0'));
   const fresh=buttons(next).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!;
   assert.notEqual(fresh.callback_data,original.callback_data);
   await f.policy.revokeChatAtRevision(OWNER,GROUP,originalVersion+1);
   assert.equal((await f.app().handle(cb(38,100,fresh.callback_data))).status,'DENIED');
   assert.equal((await f.app().handle(cb(39,100,'mi:1:g:p:0'))).status,'APPLIED');
   assert.equal(buttons(await f.app().handle(cb(40,100,'mi:1:g:p:0'))).some(b=>b.callback_data.startsWith('mi:1:g:d:')),false);
  }finally{await f.close();}
 });
}
test('inline group empty state has safe way back and no fake action',async()=>{
 const f=await fixture('sqlite');try{
  const r=await f.app().handle(msg(51,'/ownerinline'));
  assert.equal(r.status,'APPLIED');
  const list=await f.app().handle(cb(52,100,'mi:1:i:01:01'));
  assert.equal(list.status,'APPLIED');
  assert.match(list.plan?.text??'',/لا توجد/);
  assert.equal(buttons(list).some(b=>b.callback_data==='mi:1:s:01:0'),true);
  assert.equal(buttons(list).some(b=>b.callback_data==='mi:1:h'),true);
  assert.equal(buttons(list).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,0);
  assert.equal((await f.app().handle(cb(53,100,'mi:1:g:p:1'))).status,'DENIED');
 }finally{await f.close();}
});
test('duplicate Telegram callback is acknowledged but is not reprocessed',async()=>{
 const f=await fixture('json');try{
  await f.policy.approveChat(OWNER,GROUP,['navigation']);
  const input=cb(61,100,'mi:1:g:p:0');
  const first=await f.app().handle(input);
  const same=await f.app().handle(input);
  assert.equal(first.status,'APPLIED');
  assert.equal(same.status,'DUPLICATE');
  assert.equal(same.callbackQueryId,'group_61');
  assert.equal(same.plan,undefined);
 }finally{await f.close();}
});

for(const engine of ['json','sqlite'] as const){
 test('owner group card reports persisted monitor-only rules and returns to this exact group ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
   const v=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   const saved=await new GroupProtectionPolicyService(f.store,f.policy).save(OWNER,{
    chatId:GROUP,revision:1,mode:'MONITOR',rules:[
     {id:'keyword_one',kind:'WORD',value:'spam',enabled:true,action:'REVIEW'},
     {id:'phrase_two',kind:'PHRASE',value:'fake offer',enabled:false,action:'WARN'}
    ],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },v,0);
   assert.equal(saved.status,'SAVED');
   const list=await f.app().handle(cb(401,100,'mi:1:i:01:01'));
   const groupLink=buttons(list).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!.callback_data;
   const detail=await f.app().handle(cb(402,100,groupLink));
   assert.equal(detail.status,'APPLIED');
   assert.match(detail.plan?.text??'',/حالة الحماية المحلية: مراقبة فقط/);
   assert.match(detail.plan?.text??'',/قواعد مفعلة للمراقبة: 1 من 2/);
   const editorLink=buttons(detail).find(b=>b.callback_data.startsWith('gp:1:p:'))!.callback_data;
   const editor=await f.app().handle(cb(403,100,editorLink));
   assert.equal(editor.status,'APPLIED');
   assert.match(editor.plan?.text??'',/الكلمات والعبارات/);
   const returnLink=buttons(editor).find(b=>b.text==='👥 بطاقة المجموعة');
   assert.equal(returnLink?.callback_data,groupLink);
   const returned=await f.app().handle(cb(404,100,returnLink!.callback_data));
   assert.equal(returned.status,'APPLIED');
   assert.match(returned.plan?.text??'',/حالة الحماية المحلية: مراقبة فقط/);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.app().handle(cb(405,100,returnLink!.callback_data))).status,'DENIED');
  }finally{await f.close();}
 });
 test('group card never calls local policy active without scoped and current evidence ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
   let version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   let detail=await f.app().handle(cb(411,100,'mi:1:g:d:'+GROUP+':'+version+':0'));
   assert.match(detail.plan?.text??'',/حالة الحماية المحلية: غير مضبوطة/);
   await new GroupProtectionPolicyService(f.store,f.policy).save(OWNER,{
    chatId:GROUP,revision:1,mode:'MONITOR',rules:[
     {id:'keyword_one',kind:'WORD',value:'spam',enabled:true,action:'REVIEW'}
    ],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },version,0);
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
   version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   detail=await f.app().handle(cb(412,100,'mi:1:g:d:'+GROUP+':'+version+':0'));
   assert.match(detail.plan?.text??'',/حالة الحماية المحلية: تحتاج مراجعة/);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   detail=await f.app().handle(cb(413,100,'mi:1:g:d:'+GROUP+':'+version+':0'));
   assert.match(detail.plan?.text??'',/حالة الحماية المحلية: نطاق الحماية غير مصرح/);
   assert.equal(buttons(detail).some(b=>b.callback_data.startsWith('gp:1:p:')),false);
  }finally{await f.close();}
 });
}
test('owner card shortcut excludes conflicting and revoked approvals',async()=>{
 const f=await fixture('json');try{
  await f.policy.approveChat(OWNER,GROUP,['moderation']);
  const state=await f.store.snapshot();
  assert.equal(ownerGroupCardLink(state,GROUP),'mi:1:g:d:'+GROUP+':'+state.chats[0]!.version+':0');
  const corrupted=structuredClone(state);
  corrupted.chats.push({...corrupted.chats[0]!});
  assert.equal(ownerGroupCardLink(corrupted,GROUP),null);
  await f.policy.revokeChatAtRevision(OWNER,GROUP,state.chats[0]!.version);
  assert.equal(ownerGroupCardLink(await f.store.snapshot(),GROUP),null);
 }finally{await f.close();}
});

test('owner protection return targets the correct card on a later group page',async()=>{
 const f=await fixture('sqlite');try{
  for(let i=0;i<9;i++)await f.policy.approveChat(OWNER,'-10000'+i,['navigation']);
  await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
  const state=await f.store.snapshot(),v=state.chats.find(c=>c.id===GROUP)!.version;
  const groupLink=ownerGroupCardLink(state,GROUP);
  assert.equal(groupLink,'mi:1:g:d:'+GROUP+':'+v+':1');
  const detail=await f.app().handle(cb(501,100,groupLink!));
  assert.equal(detail.status,'APPLIED');
  assert.match(detail.plan?.text??'',new RegExp(GROUP));
  const editorLink=buttons(detail).find(b=>b.callback_data.startsWith('gp:1:p:'))!.callback_data;
  const editor=await f.app().handle(cb(502,100,editorLink));
  assert.equal(editor.status,'APPLIED');
  assert.equal(buttons(editor).find(b=>b.text==='👥 بطاقة المجموعة')?.callback_data,groupLink);
  const returned=await f.app().handle(cb(503,100,groupLink!));
  assert.equal(returned.status,'APPLIED');
  const forgedPage=groupLink!.replace(/:1$/u,':0');
  assert.equal((await f.app().handle(cb(504,100,forgedPage))).status,'DENIED');
 }finally{await f.close();}
});

test('group local-rights summary selector has strict callback grammar',()=>{
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:s:0'),{kind:'summary',page:0});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:s:12'),{kind:'summary',page:12});
 for(const data of ['mi:1:g:s:00','mi:1:g:s:-1','mi:1:g:s:1000',
  'mi:1:g:s:0:1','mi:1:g:s:0\\n','mi:2:g:s:0'])
  assert.equal(parseOwnerInlineGroupRoute(data),null,data);
});
for(const engine of ['json','sqlite'] as const){
 test('owner local-rights overview is read-only, safely paged, and linked from approved section ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation','verification']);
   for(let i=0;i<10;i++)await f.policy.approveChat(OWNER,'-100'+String(2000+i),['navigation']);
   const version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   assert.equal((await new GroupProtectionPolicyService(f.store,f.policy).save(OWNER,{
    chatId:GROUP,revision:1,mode:'MONITOR',rules:[
     {id:'one',kind:'WORD',value:'spam',enabled:true,action:'REVIEW'}],
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},version,0)).status,'SAVED');
   const before=(await f.store.snapshot()).protectionPolicies;
   const groups=await f.app().handle(cb(601,100,'mi:1:i:01:01'));
   assert.equal(groups.status,'APPLIED');
   const shortcut=buttons(groups).find(b=>b.callback_data==='mi:1:g:s:0');
   assert.ok(shortcut,'group browser must offer scoped rights overview');
   const summary=await f.app().handle(cb(602,100,'mi:1:i:01:10'));
   assert.equal(summary.status,'APPLIED');
   assert.match(summary.plan?.text??'',/فحص الصلاحيات المحلية/);
   assert.match(summary.plan?.text??'',/لا يتحقق.*Telegram/);
   assert.match(summary.plan?.text??'',/المجموعات المعتمدة: 11/);
   assert.match(summary.plan?.text??'',/مراقبة فقط/);
   assert.equal(isValidTelegramInlineKeyboard(summary.plan?.inlineMarkup),true);
   const groupLink=buttons(summary).find(b=>b.callback_data.startsWith('mi:1:g:d:'));
   assert.ok(groupLink);
   const card=await f.app().handle(cb(603,100,groupLink!.callback_data));
   assert.equal(card.status,'APPLIED');
   const second=await f.app().handle(cb(604,100,'mi:1:g:s:1'));
   assert.equal(second.status,'APPLIED');
   assert.equal(buttons(second).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,3);
   assert.ok(buttons(second).some(b=>b.callback_data==='mi:1:g:s:0'));
   assert.equal((await f.app().handle(cb(605,100,'mi:1:g:s:2'))).status,'DENIED');
   assert.deepEqual((await f.store.snapshot()).protectionPolicies,before);
   assert.equal((await f.app().handle(cb(606,300,'mi:1:i:01:10'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(607,100,'mi:1:i:01:10','supergroup'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('local-rights summary quarantines stale policy and changes after approval revocation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
   const version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   assert.equal((await new GroupProtectionPolicyService(f.store,f.policy).save(OWNER,{
    chatId:GROUP,revision:1,mode:'MONITOR',rules:[],
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},version,0)).status,'SAVED');
   const first=await f.app().handle(cb(611,100,'mi:1:g:s:0'));
   assert.match(first.plan?.text??'',/مراقبة فقط/);
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
   const stale=await f.app().handle(cb(612,100,'mi:1:g:s:0'));
   assert.match(stale.plan?.text??'',/تحتاج مراجعة/);
   assert.doesNotMatch(stale.plan?.text??'',/مراقبة فقط/);
   await f.policy.revokeChatAtRevision(OWNER,GROUP,(await f.store.snapshot()).chats[0]!.version);
   const empty=await f.app().handle(cb(613,100,'mi:1:g:s:0'));
   assert.equal(empty.status,'APPLIED');
   assert.match(empty.plan?.text??'',/المجموعات المعتمدة: 0/);
   assert.equal(buttons(empty).some(b=>b.callback_data.startsWith('mi:1:g:d:')),false);
  }finally{await f.close();}
 });
}

test('future-dated protection evidence cannot appear active in either owner view',async()=>{
 const f=await fixture('json');try{
  await f.policy.approveChat(OWNER,GROUP,['navigation','moderation']);
  const version=(await f.store.snapshot()).chats[0]!.version;
  assert.equal((await new GroupProtectionPolicyService(f.store,f.policy).save(OWNER,{
   chatId:GROUP,revision:1,mode:'MONITOR',
   rules:[{id:'rule_one',kind:'WORD',value:'spam',enabled:true,action:'WARN'}],
   allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
  },version,0)).status,'SAVED');
  await f.store.transaction(s=>{s.protectionPolicies![0]!.updatedAt=Date.now()+120_000;});
  const summary=await f.app().handle(cb(701,100,'mi:1:i:01:10'));
  assert.equal(summary.status,'APPLIED');
  assert.match(summary.plan?.text??'',/تحتاج مراجعة/);
  assert.doesNotMatch(summary.plan?.text??'',/مراقبة فقط/);
  const card=await f.app().handle(cb(702,100,'mi:1:g:d:'+GROUP+':'+version+':0'));
  assert.equal(card.status,'APPLIED');
  assert.match(card.plan?.text??'',/حالة الحماية المحلية: تحتاج مراجعة/);
  assert.doesNotMatch(card.plan?.text??'',/قواعد مفعلة للمراقبة/);
 }finally{await f.close();}
});


test('owner group diagnostics route grammar is bounded and canonical',()=>{
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:n:0'),{kind:'alerts',page:0});
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:o:1'),{kind:'modes',page:1});
 for(const invalid of ['mi:1:g:n:00','mi:1:g:n:-1','mi:1:g:n:1000','mi:1:g:n:0:extra',
  'mi:1:g:o:00','mi:1:g:o:9999','mi:1:g:o:0\n','mi:2:g:n:0']){
  assert.equal(parseOwnerInlineGroupRoute(invalid),null,invalid);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('network alerts show only approved-group local concerns with protected drilldown ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation','verification']);
   await f.policy.approveChat(OWNER,'-100124',['navigation']);
   await f.policy.setPresence('-100124',true);
   const groupVersion=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   const index=await f.app().handle(cb(801,100,'mi:1:i:01:09'));
   assert.equal(index.status,'APPLIED');
   assert.match(index.plan?.text??'',/تنبيهات الشبكة المحلية/);
   assert.match(index.plan?.text??'',/وجود البوت غير مؤكد/);
   assert.match(index.plan?.text??'',/سياسة الحماية غير مضبوطة/);
   assert.match(index.plan?.text??'',/لا توجد قنوات اشتراك محفوظة/);
   assert.match(index.plan?.text??'',/ليس.*تنبيه.*Telegram/);
   assert.equal(isValidTelegramInlineKeyboard(index.plan?.inlineMarkup),true);
   const link=buttons(index).find(b=>b.callback_data==='mi:1:g:d:'+GROUP+':'+groupVersion+':0');
   assert.ok(link);
   assert.equal((await f.app().handle(cb(802,100,link!.callback_data))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(803,300,'mi:1:i:01:09'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(804,100,'mi:1:i:01:09','supergroup'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(805,100,'mi:1:g:n:1'))).status,'DENIED');
   await f.policy.revokeChatAtRevision(OWNER,GROUP,groupVersion);
   const after=await f.app().handle(cb(806,100,'mi:1:g:n:0'));
   assert.equal(after.status,'APPLIED');
   assert.doesNotMatch(after.plan?.text??'',new RegExp(GROUP));
  }finally{await f.close();}
 });
 test('group operating modes disclose stored settings without suggesting live enforcement ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   for(let i=0;i<9;i++)
    await f.policy.approveChat(OWNER,'-100'+String(1000+i),['navigation']);
   await f.policy.approveChat(OWNER,GROUP,['navigation','moderation','publishing','assistant']);
   const version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
   const saved=await new GroupProtectionPolicyService(f.store,f.policy).save(OWNER,{
    chatId:GROUP,revision:1,mode:'MONITOR',rules:[
     {id:'spamword',kind:'WORD',value:'spam',enabled:true,action:'REVIEW'}],
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]
   },version,0);
   assert.equal(saved.status,'SAVED');
   const before=(await f.store.snapshot()).protectionPolicies;
   const modes=await f.app().handle(cb(821,100,'mi:1:i:01:11'));
   assert.equal(modes.status,'APPLIED');
   assert.match(modes.plan?.text??'',/أوضاع التشغيل المحلية/);
   assert.match(modes.plan?.text??'',/لا تنفذ عقوبات Telegram/);
   assert.equal(isValidTelegramInlineKeyboard(modes.plan?.inlineMarkup),true);
   const next=buttons(modes).find(b=>b.callback_data==='mi:1:g:o:1');
   assert.ok(next);
   const more=await f.app().handle(cb(822,100,next!.callback_data));
   assert.equal(more.status,'APPLIED');
   assert.match(more.plan?.text??'',/مراقبة فقط/);
   assert.match(more.plan?.text??'',/النشر: مصرح محليًا/);
   assert.equal(buttons(more).filter(b=>b.callback_data.startsWith('mi:1:g:d:')).length,2);
   assert.ok(buttons(more).some(b=>b.callback_data==='mi:1:g:o:0'));
   assert.equal((await f.app().handle(cb(823,100,'mi:1:g:o:2'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(824,300,'mi:1:i:01:11'))).status,'DENIED');
   assert.deepEqual((await f.store.snapshot()).protectionPolicies,before);
  }finally{await f.close();}
 });
}
