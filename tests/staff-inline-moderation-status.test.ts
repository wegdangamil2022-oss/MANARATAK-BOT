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
import {staffInlineRoute} from '../src/telegram-inline-staff.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';

const OWNER='100',STAFF='301',GROUP='-100123',TARGET='300';
const message=(i:number,actor:number,text:string)=>({
 update_id:i,message:{message_id:i,chat:{id:actor,type:'private'},from:{id:actor,is_bot:false},text}
});
const cb=(i:number,actor:number,data:string,group=false)=>({
 update_id:i,callback_query:{id:'status_'+i,from:{id:actor,is_bot:false},data,
  message:{message_id:88,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
   from:{id:987,is_bot:true}}
 }
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const op=(i:number,status:'INTENT'|'STARTED'|'CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED')=>({
 id:'case-'+i,chatId:GROUP,memberId:TARGET,actorId:STAFF,kind:i%2===0?'MUTE' as const:'BAN' as const,
 reasonFingerprint:'secret-sensitive-fingerprint',policyVersion:1,status,
 createdAt:1700000000000+i
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-operations-inline-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 let now=1700000000000;
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>now});
 await policy.approveChat(OWNER,GROUP,['navigation','moderation']);
 await policy.grant(OWNER,STAFF,'chat.manage',GROUP,now+60000);
 return {store,policy,app,advance:(ms:number)=>{now+=ms},close:()=>rm(dir,{recursive:true,force:true})};
}
test('operation status route rejects noncanonical selectors, oversized and extra fields',()=>{
 assert.deepEqual(staffInlineRoute('ms:1:o:-100123:1:0:2:abcdef012345'),
 {kind:'operations',chatId:GROUP,version:1,page:0,operationPage:2,digest:'abcdef012345'});
 for(const invalid of ['ms:1:o:-100123:01:0:2:abcdef012345',
  'ms:1:o:-100123:1:00:2:abcdef012345',
  'ms:1:o:-100123:1:0:02:abcdef012345',
  'ms:1:o:-100123:1:0:2:ABCDEF012345',
  'ms:1:o:-100123:1:0:2:abcdef012345\\n',
  'ms:1:o:-100123:1:0:2:abcdef012345:resend',
  'ms:1:o:100123:1:0:2:abcdef012345',
  'ms:1:o:-100123:0:0:2:abcdef012345',
  'ms:1:o:-100123:1:0:1000:abcdef012345',
  'ms:2:o:-100123:1:0:2:abcdef012345'])
   assert.equal(staffInlineRoute(invalid),null,invalid);
});
for(const engine of ['json','sqlite'] as const){
 test('staff sees ONLY local group operation-status inventory and zero member identities ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    s.moderationOperations.push(op(1,'CONFIRMED'),op(2,'FAILED_CONFIRMED'),
     op(3,'UNKNOWN_OUTCOME'),op(4,'STARTED'),op(5,'INTENT'),op(6,'CANCELLED'));
    s.moderationOperations.push({...op(7,'CONFIRMED'),chatId:'-100234'});
   });
   const home=await f.app().handle(message(1,301,'/staffinline'));
   const detailKey=buttons(home).find(x=>x.callback_data.startsWith('ms:1:g:'))!.callback_data;
   const detail=await f.app().handle(cb(2,301,detailKey));
   assert.equal(detail.status,'APPLIED');
   const statusKey=buttons(detail).find(x=>x.callback_data.startsWith('ms:1:o:'))!.callback_data;
   const ops=await f.app().handle(cb(3,301,statusKey));
   assert.equal(ops.status,'APPLIED');
   assert.equal(ops.plan?.editMessageId,88);
   assert.equal(isValidTelegramInlineKeyboard(ops.plan?.inlineMarkup),true);
   assert.match(ops.plan?.text??'',/مجهولة|مجهول/);
   assert.match(ops.plan?.text??'',/مؤكدة|مؤكد/);
   assert.match(ops.plan?.text??'',/معلق|معلّق/);
   assert.doesNotMatch(ops.plan?.text??'',/secret-sensitive-fingerprint|case-1|memberId|actorId|301|300|302|303/);
   assert.equal(buttons(ops).some(x=>x.callback_data===detailKey),true);
   assert.equal(buttons(ops).some(x=>x.callback_data==='ms:1:h'),true);
   assert.equal(buttons(ops).some(x=>x.callback_data.startsWith('c_')),false);
   assert.equal(buttons(ops).some(x=>/ban|mute|resend/iu.test(x.text)),false);
   assert.equal((await f.store.snapshot()).moderationOperations.length,7);
  }finally{await f.close();}
 });
 test('19-operation pagination lists eight per page but cannot execute or retry outcomes ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{for(let i=0;i<19;i++)s.moderationOperations.push(op(i,'UNKNOWN_OUTCOME'));});
   const home=await f.app().handle(message(10,301,'/staffinline'));
   const detail=await f.app().handle(cb(11,301,buttons(home).find(x=>x.callback_data.startsWith('ms:1:g:'))!.callback_data));
   const p0=await f.app().handle(cb(12,301,buttons(detail).find(x=>x.callback_data.startsWith('ms:1:o:'))!.callback_data));
   assert.match(p0.plan?.text??'',/صفحة 1 من 3/);
   const p1Key=buttons(p0).find(x=>x.callback_data.startsWith('ms:1:o:')&&x.text.includes('التالي'))!.callback_data;
   const p1=await f.app().handle(cb(13,301,p1Key));
   assert.equal(p1.status,'APPLIED');
   assert.match(p1.plan?.text??'',/صفحة 2 من 3/);
   const p2=await f.app().handle(cb(14,301,buttons(p1).find(x=>x.callback_data.startsWith('ms:1:o:')&&x.text.includes('التالي'))!.callback_data));
   assert.equal(p2.status,'APPLIED');
   assert.match(p2.plan?.text??'',/صفحة 3 من 3/);
   assert.equal(buttons(p2).filter(x=>x.text.includes('التالي')).length,0);
   assert.equal((await f.store.snapshot()).moderationOperations.filter(x=>x.status==='UNKNOWN_OUTCOME').length,19);
  }finally{await f.close();}
 });
 test('old list selector fails closed on new operation, changed outcome or policy ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push(op(1,'INTENT')));
   const home=await f.app().handle(message(20,301,'/staffinline'));
   const detailKey=buttons(home).find(x=>x.callback_data.startsWith('ms:1:g:'))!.callback_data;
   const detail=await f.app().handle(cb(21,301,detailKey));
   const key=buttons(detail).find(x=>x.callback_data.startsWith('ms:1:o:'))!.callback_data;
   await f.store.transaction(s=>{s.moderationOperations[0]!.status='UNKNOWN_OUTCOME';});
   assert.equal((await f.app().handle(cb(22,301,key))).status,'DENIED');
   const newDetail=await f.app().handle(cb(23,301,detailKey));
   const refreshed=buttons(newDetail).find(x=>x.callback_data.startsWith('ms:1:o:'))!.callback_data;
   assert.notEqual(refreshed,key);
   await f.store.transaction(s=>s.moderationOperations.push(op(2,'INTENT')));
   assert.equal((await f.app().handle(cb(24,301,refreshed))).status,'DENIED');
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal((await f.app().handle(cb(25,301,detailKey))).status,'DENIED');
  }finally{await f.close();}
 });
 test('grant revoked/expired, forged actor and group callbacks never expose operation status ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push(op(1,'UNKNOWN_OUTCOME')));
   const home=await f.app().handle(message(30,301,'/staffinline'));
   const detailKey=buttons(home).find(x=>x.callback_data.startsWith('ms:1:g:'))!.callback_data;
   const detail=await f.app().handle(cb(31,301,detailKey));
   const operationKey=buttons(detail).find(x=>x.callback_data.startsWith('ms:1:o:'))!.callback_data;
   assert.equal((await f.app().handle(cb(32,200,operationKey))).status,'DENIED');
   assert.equal((await f.app().handle(cb(33,301,operationKey,true))).status,'DENIED');
   await f.policy.revokeGrant(OWNER,STAFF,'chat.manage',GROUP);
   assert.equal((await f.app().handle(cb(34,301,operationKey))).status,'DENIED');
   assert.equal((await f.app().handle(cb(35,301,'ms:1:h'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('empty operation ledger shows no cases, explicit no-retry warning and safe return ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(message(40,301,'/staffinline'));
   const detail=await f.app().handle(cb(41,301,buttons(home).find(x=>x.callback_data.startsWith('ms:1:g:'))!.callback_data));
   const opView=await f.app().handle(cb(42,301,buttons(detail).find(x=>x.callback_data.startsWith('ms:1:o:'))!.callback_data));
   assert.equal(opView.status,'APPLIED');
   assert.match(opView.plan?.text??'',/لا توجد/);
   assert.match(opView.plan?.text??'',/إعادة إرسال|إعادة تنفيذ/);
   assert.equal(isValidTelegramInlineKeyboard(opView.plan?.inlineMarkup),true);
  }finally{await f.close();}
 });
}
