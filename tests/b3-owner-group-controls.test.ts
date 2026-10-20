import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels,parseOwnerGroupAction} from '../src/telegram-owner-menu.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER='100',STUDENT=300,CHAT='-100123';
const msg=(id:number,text:string,actor=100,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-group-admin-'));
 const file=join(dir,engine==='sqlite'?'state.sqlite':'state.json');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,CHAT,['navigation','assistant','moderation','publishing']);
 await policy.setPresence(CHAT,true);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,store,policy,app,close:()=>rm(dir,{force:true,recursive:true})};
}
test('B3 owner groups: real listing, per-chat details, explicit restrictive actions, never live presence claim',async()=>{
 const f=await fixture();try{
  const list=await f.app().handle(msg(1,ownerMenuLabels.groups));
  assert.equal(list.status,'APPLIED');assert.match(list.plan?.text??'',/المجموعات المعتمدة/);
  assert.ok(buttons(list).includes('🏷️ محادثة · '+CHAT));
  assert.equal(isValidTelegramReplyKeyboard(list.plan?.replyMarkup),true);
  const detail=await f.app().handle(msg(2,'🏷️ محادثة · '+CHAT));
  assert.equal(detail.status,'APPLIED');assert.match(detail.plan?.text??'',/navigation/);
  assert.match(detail.plan?.text??'',/محلية|محفوظة/);
  assert.equal(isValidTelegramReplyKeyboard(detail.plan?.replyMarkup),true);
  const choices=buttons(detail);
  assert.ok(choices.some(x=>x.startsWith('🚫 مراجعة الإلغاء · '+CHAT+':')));
  assert.ok(choices.some(x=>x.startsWith('🔐 تقييد navigation · '+CHAT+':')));
  assert.ok(choices.some(x=>x.startsWith('🛑 مراجعة إيقاف AI · '+CHAT+':')));
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+' group scope restriction: preview read-only, confirmation CAS, stale button rejected',async()=>{
  const f=await fixture(engine);try{
   const first=await f.app().handle(msg(11,'🏷️ محادثة · '+CHAT));
   const select=buttons(first).find(x=>x.startsWith('🔐 تقييد navigation · '))!;
   const before=await f.store.snapshot();const version=before.chats[0]!.version;
   const preview=await f.app().handle(msg(12,select));
   assert.equal(preview.status,'APPLIED');assert.match(preview.plan?.text??'',/تأكيد|مراجعة/);
   assert.deepEqual((await f.store.snapshot()).chats[0]!.scopes,before.chats[0]!.scopes);
   const confirm=buttons(preview).find(x=>x.startsWith('✅ تأكيد تقييد navigation · '))!;
   const applied=await f.app().handle(msg(13,confirm));
   assert.equal(applied.status,'APPLIED');
   const after=(await f.store.snapshot()).chats[0]!;
   assert.equal(after.version,version+1);
   assert.equal(after.scopes.includes('navigation'),false);
   assert.equal(after.approved,true);
   assert.equal((await f.app().handle(msg(14,confirm))).status,'DENIED');
   assert.equal((await f.app().handle(msg(15,select))).status,'DENIED');
   assert.equal((await f.store.snapshot()).chats[0]!.version,version+1);
  }finally{await f.close();}
 });
}
test('B3 groups: owner preview and confirm revoke remains local, does not call Telegram leave',async()=>{
 const f=await fixture();try{
  const before=await f.app().handle(msg(21,'🏷️ محادثة · '+CHAT));
  const review=buttons(before).find(x=>x.startsWith('🚫 مراجعة الإلغاء · '))!;
  const p=await f.app().handle(msg(22,review));
  assert.equal(p.status,'APPLIED');assert.equal((await f.store.snapshot()).chats[0]!.approved,true);
  const confirm=buttons(p).find(x=>x.startsWith('⛔ تأكيد الإلغاء · '))!;
  const done=await f.app().handle(msg(23,confirm));
  assert.equal(done.status,'APPLIED');
  const state=await f.store.snapshot();
  assert.equal(state.chats[0]!.approved,false);
  assert.equal(state.chats[0]!.groupAI,'OFF');
  assert.equal(state.operations.length,0);
  assert.equal((await f.app().handle(msg(24,confirm))).status,'DENIED');
  assert.equal((await f.app().handle(msg(25,'🏷️ محادثة · '+CHAT))).status,'APPLIED');
  assert.ok(!buttons(await f.app().handle(msg(26,'🏷️ محادثة · '+CHAT))).some(x=>x.includes('تأكيد الإلغاء')));
 }finally{await f.close();}
});
test('B3 groups: OFF-only AI control is restrictive and leaves current Telegram membership untouched',async()=>{
 const f=await fixture();try{
  await f.policy.configureGroupAI(OWNER,CHAT,'ALL_MENTION');
  const screen=await f.app().handle(msg(30,'🏷️ محادثة · '+CHAT));
  const preview=buttons(screen).find(x=>x.startsWith('🛑 مراجعة إيقاف AI · '))!;
  const p=await f.app().handle(msg(31,preview));
  assert.equal(p.status,'APPLIED');
  assert.equal((await f.store.snapshot()).chats[0]!.groupAI,'ALL_MENTION');
  const confirm=buttons(p).find(x=>x.startsWith('🔒 تأكيد إيقاف AI · '))!;
  const applied=await f.app().handle(msg(32,confirm));
  assert.equal(applied.status,'APPLIED');
  const state=(await f.store.snapshot()).chats[0]!;
  assert.equal(state.groupAI,'OFF');assert.equal(state.present,true);
  assert.equal((await f.app().handle(msg(33,confirm))).status,'DENIED');
 }finally{await f.close();}
});
test('B3 groups: restricting assistant scope automatically turns group AI OFF',async()=>{
 const f=await fixture();try{
  await f.policy.configureGroupAI(OWNER,CHAT,'OWNER_MENTION');
  const screen=await f.app().handle(msg(40,'🏷️ محادثة · '+CHAT));
  const review=buttons(screen).find(x=>x.startsWith('🔐 تقييد assistant · '))!;
  const p=await f.app().handle(msg(41,review));
  const confirm=buttons(p).find(x=>x.startsWith('✅ تأكيد تقييد assistant · '))!;
  assert.equal((await f.app().handle(msg(42,confirm))).status,'APPLIED');
  const after=(await f.store.snapshot()).chats[0]!;
  assert.equal(after.groupAI,'OFF');assert.equal(after.scopes.includes('assistant'),false);
 }finally{await f.close();}
});
test('B3 groups: version race on owner mutation is atomic and denied on stale confirmation',async()=>{
 const f=await fixture('sqlite');try{
  const opened=await f.app().handle(msg(50,'🏷️ محادثة · '+CHAT));
  const preview=await f.app().handle(msg(51,buttons(opened).find(x=>x.startsWith('🚫 مراجعة الإلغاء · '))!));
  const confirm=buttons(preview).find(x=>x.startsWith('⛔ تأكيد الإلغاء · '))!;
  await f.policy.approveChat(OWNER,CHAT,['navigation','assistant']);
  assert.equal((await f.app().handle(msg(52,confirm))).status,'DENIED');
  assert.equal((await f.store.snapshot()).chats[0]!.approved,true);
  const before=(await f.store.snapshot()).chats[0]!.version;
  await assert.rejects(f.policy.revokeChatAtRevision(OWNER,CHAT,before-1),/CHAT_POLICY_STALE/);
  assert.equal((await f.store.snapshot()).chats[0]!.version,before);
 }finally{await f.close();}
});
test('B3 group list paginates 13 saved groups without duplicate, and invalid pages never leak',async()=>{
 const f=await fixture();try{
  for(let i=1;i<=12;i++)await f.policy.approveChat(OWNER,'-1009'+String(i).padStart(3,'0'),['navigation']);
  const a=await f.app().handle(msg(60,ownerMenuLabels.groups));
  assert.match(a.plan?.text??'',/صفحة 1 من 2/);
  assert.equal(buttons(a).filter(x=>x.startsWith('🏷️ محادثة · ')).length,10);
  const page2=buttons(a).find(x=>x==='➡️ التالي · o:g:1')!;
  assert.ok(page2);
  const b=await f.app().handle(msg(61,page2));
  assert.match(b.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(buttons(b).filter(x=>x.startsWith('🏷️ محادثة · ')).length,3);
  assert.equal(isValidTelegramReplyKeyboard(b.plan?.replyMarkup),true);
  assert.equal((await f.app().handle(msg(62,'⬅️ السابق · o:g:0'))).status,'APPLIED');
  for(const text of ['➡️ التالي · o:g:999','➡️ التالي · o:g:0',
   '⬅️ السابق · o:g:1','➡️ التالي · o:g:01','➡️ التالي · o:g:-1']){
   const r=await f.app().handle(msg(70+text.length,text));
   assert.equal(r.status,'DENIED');assert.equal(r.plan,undefined);
  }
 }finally{await f.close();}
});
test('B3 group controls: student/delegate/group actor never can inspect, restrict, revoke or disable AI',async()=>{
 const f=await fixture();try{
  const admin=await f.app().handle(msg(80,'🏷️ محادثة · '+CHAT));
  const cmds=['🏷️ محادثة · '+CHAT,
    ...buttons(admin).filter(x=>x.includes(CHAT)),
    '⛔ تأكيد الإلغاء · '+CHAT+':1',
    '✅ تأكيد تقييد navigation · '+CHAT+':1'];
  for(const [i,cmd] of cmds.entries())for(const actor of [200,STUDENT]){
   const r=await f.app().handle(msg(90+i*4+actor%9,cmd,actor));
   assert.equal(r.status,'DENIED',cmd);assert.equal(r.plan,undefined);
  }
  const inGroup=await f.app().handle(msg(190,'⛔ تأكيد الإلغاء · '+CHAT+':1',100,true));
  assert.equal(inGroup.plan,undefined);
  assert.equal((await f.store.snapshot()).chats[0]!.approved,true);
 }finally{await f.close();}
});
test('B3 group action parser: canonical labels, scoped version, explicit phase, no forged modes',()=>{
 for(const cmd of ['🏷️ محادثة · -100123','🚫 مراجعة الإلغاء · -100123:1',
  '⛔ تأكيد الإلغاء · -100123:1','🔐 تقييد assistant · -100123:12',
  '✅ تأكيد تقييد navigation · -100123:2','🛑 مراجعة إيقاف AI · -100123:1',
  '🔒 تأكيد إيقاف AI · -100123:1'])assert.ok(parseOwnerGroupAction(cmd),cmd);
 for(const cmd of ['🏷️ محادثة · @mychannel','⛔ تأكيد الإلغاء · 100:1',
  '⛔ تأكيد الإلغاء · -100123:01','⛔ تأكيد الإلغاء · -100123:-1',
  '✅ تأكيد تقييد admin · -100123:1','✅ تأكيد تقييد assistant · -100123:1\n',
  '🔓 تفعيل AI · -100123:1','🔓 إعادة اعتماد · -100123:1',
  '🏷️ محادثة · -100123 extra'])assert.equal(parseOwnerGroupAction(cmd),null,cmd);
});
test('B3 group policy mutation denies nonowner, unknown scope, revoked/disabled chat and never escalates',async()=>{
 const f=await fixture();try{
  const v=(await f.store.snapshot()).chats[0]!.version;
  await assert.rejects(f.policy.restrictChatScopeAtRevision('300',CHAT,'navigation',v),/OWNER_ONLY/);
  await assert.rejects(f.policy.restrictChatScopeAtRevision(OWNER,CHAT,'dangerous',v),/INVALID_CHAT_SCOPE/);
  await assert.rejects(f.policy.disableGroupAIAtRevision('200',CHAT,v),/OWNER_ONLY/);
  await f.policy.revokeChatAtRevision(OWNER,CHAT,v);
  await assert.rejects(f.policy.restrictChatScopeAtRevision(OWNER,CHAT,'navigation',v+1),/CHAT_NOT_APPROVED/);
  await assert.rejects(f.policy.revokeChatAtRevision(OWNER,CHAT,v+1),/CHAT_NOT_APPROVED/);
 }finally{await f.close();}
});
