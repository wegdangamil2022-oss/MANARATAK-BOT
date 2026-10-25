import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type OperationStatus,type RestrictionKind} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {parseOwnerInlineGroupRoute} from '../src/telegram-inline-groups.js';

const OWNER='100',GROUP='-100123';
const event=(id:number,actor:number,selector:string,group=false)=>({
 update_id:id,callback_query:{id:'reversal_'+id,from:{id:actor,is_bot:false},data:selector,
 message:{message_id:56,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-reversal-inventory-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 await policy.approveChat(OWNER,GROUP,['navigation','moderation']);
 const v=(await store.snapshot()).chats[0]!.version;
 const operation=(member:string,status:OperationStatus,rev=v,kind:RestrictionKind='BAN')=>({
  id:'op-'+member,chatId:GROUP,memberId:member,actorId:OWNER,kind,
  reasonFingerprint:'SECRET-EVIDENCE-'+member,policyVersion:rev,status,createdAt:1700000000000
 });
 return {store,policy,app,v,operation,close:()=>rm(dir,{recursive:true,force:true})};
}
test('owner reversal inventory callback route is canonical, bounded and read only',()=>{
 assert.deepEqual(parseOwnerInlineGroupRoute('mi:1:g:r:-100123:2:0:abcdef012345'),
  {kind:'reversal',chatId:GROUP,version:2,page:0,digest:'abcdef012345'});
 for(const bad of ['mi:1:g:r:-100123:2:0:ABCDEF012345',
  'mi:1:g:r:-100123:2:0:abcdef012345:release',
  'mi:1:g:r:-100123:02:0:abcdef012345',
  'mi:1:g:r:-100123:2:00:abcdef012345',
  'mi:1:g:r:100123:2:0:abcdef012345',
  'mi:1:g:r:-100123:2:0:abc','mi:1:g:r:-100123:2:0:abcdef012345\n'])
 assert.equal(parseOwnerInlineGroupRoute(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('owner group card shows read-only local reversal blocker inventory, no identities or unlock ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    s.moderationOperations.push(
     f.operation('701','UNKNOWN_OUTCOME'),f.operation('702','STARTED'),
     f.operation('703','CONFIRMED'),f.operation('704','CONFIRMED'),
     f.operation('705','FAILED_CONFIRMED'),f.operation('706','CONFIRMED',f.v+1));
    s.moderationReasons.push({chatId:GROUP,memberId:'703',source:'MANUAL',
     reference:'secret-reference',kind:'BAN',createdBy:OWNER,active:true});
   });
   const before=await f.store.snapshot();
   const list=await f.app().handle(event(1,100,'mi:1:g:p:0'));
   const card=await f.app().handle(event(2,100,
    buttons(list).find(b=>b.callback_data.startsWith('mi:1:g:d:'))!.callback_data));
   assert.equal(card.status,'APPLIED');
   const btn=buttons(card).find(b=>b.callback_data.startsWith('mi:1:g:r:'))!;
   assert.ok(btn);
   const view=await f.app().handle(event(3,100,btn.callback_data));
   assert.equal(view.status,'APPLIED');
   assert.equal(view.plan?.editMessageId,56);
   assert.equal(isValidTelegramInlineKeyboard(view.plan?.inlineMarkup),true);
   const text=view.plan?.text??'';
   for(const fragment of ['مجهولة: 1','معلقة: 1','أسباب نشطة: 1',
    'نقص أدلة: 1','اختلاف إصدار: 1','مرشحة لفحص خارجي: 1',
    'لا تعني السماح بفك','لا يوجد زر'])
    assert.ok(text.includes(fragment),fragment+' '+text);
   assert.doesNotMatch(text,/SECRET-EVIDENCE|secret-reference|701|702|703|704|705|706/);
   assert.equal(buttons(view).some(b=>b.callback_data.startsWith('c_')),false);
   assert.equal(buttons(view).some(b=>b.callback_data.startsWith('mi:1:g:d:')),true);
   const after=await f.store.snapshot();
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
   assert.deepEqual(after.moderationReasons,before.moderationReasons);
   assert.deepEqual(after.chats,before.chats);
  }finally{await f.close();}
 });
 test('changing a stored operation or reason invalidates previously issued inventory route ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push(f.operation('701','CONFIRMED')));
   const card=await f.app().handle(event(10,100,'mi:1:g:d:'+GROUP+':'+f.v+':0'));
   const old=buttons(card).find(x=>x.callback_data.startsWith('mi:1:g:r:'))!.callback_data;
   assert.equal((await f.app().handle(event(11,100,old))).status,'APPLIED');
   await f.store.transaction(s=>s.moderationOperations[0]!.status='UNKNOWN_OUTCOME');
   assert.equal((await f.app().handle(event(12,100,old))).status,'DENIED');
   const refreshed=await f.app().handle(event(13,100,'mi:1:g:d:'+GROUP+':'+f.v+':0'));
   const next=buttons(refreshed).find(x=>x.callback_data.startsWith('mi:1:g:r:'))!.callback_data;
   assert.notEqual(old,next);
   await f.store.transaction(s=>s.moderationReasons.push({
    chatId:GROUP,memberId:'701',reference:'private',source:'MANUAL',
    kind:'BAN',createdBy:OWNER,active:true}));
   assert.equal((await f.app().handle(event(14,100,next))).status,'DENIED');
  }finally{await f.close();}
 });
 test('non-owner, group context, policy change and revoked group block inventory ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const card=await f.app().handle(event(20,100,'mi:1:g:d:'+GROUP+':'+f.v+':0'));
   const token=buttons(card).find(x=>x.callback_data.startsWith('mi:1:g:r:'))!.callback_data;
   assert.equal((await f.app().handle(event(21,301,token))).status,'DENIED');
   assert.equal((await f.app().handle(event(22,100,token,true))).status,'DENIED');
   assert.equal((await f.app().handle(event(23,100,token.slice(0,-1)+(token.endsWith('0')?'1':'0')))).status,'DENIED');
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.app().handle(event(24,100,token))).status,'DENIED');
   const nextVersion=(await f.store.snapshot()).chats[0]!.version;
   const changed=await f.app().handle(event(25,100,'mi:1:g:d:'+GROUP+':'+nextVersion+':0'));
   assert.equal(buttons(changed).some(x=>x.callback_data.startsWith('mi:1:g:r:')),false);
   await f.policy.revokeChatAtRevision(OWNER,GROUP,nextVersion);
   assert.equal((await f.app().handle(event(26,100,token))).status,'DENIED');
  }finally{await f.close();}
 });
 test('empty moderation ledger explains lack of local evidence without suggesting release ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const card=await f.app().handle(event(30,100,'mi:1:g:d:'+GROUP+':'+f.v+':0'));
   const key=buttons(card).find(x=>x.callback_data.startsWith('mi:1:g:r:'))!.callback_data;
   const view=await f.app().handle(event(31,100,key));
   assert.equal(view.status,'APPLIED');
   assert.match(view.plan?.text??'',/لا توجد سجلات/);
   assert.match(view.plan?.text??'',/لا.*فك/);
  }finally{await f.close();}
 });
}
