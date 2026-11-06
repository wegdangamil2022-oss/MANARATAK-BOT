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
import {validWhisperOwnerRoute} from '../src/phase4-whisper-owner.js';
import {isValidTelegramInlineKeyboard,ownerInlineConnection} from '../src/telegram-inline-owner.js';

const OWNER='100',GROUP='-1001234',MEMBER='200';
const privateMsg=(id:number,text:string,actor=OWNER)=>({
 update_id:id,message:{message_id:id,chat:{id:Number(actor),type:'private'},
  from:{id:Number(actor),is_bot:false},text}
});
const callback=(id:number,data:string,actor=OWNER)=>({
 update_id:id,callback_query:{id:'Q'+id,data,from:{id:Number(actor),is_bot:false},
  message:{message_id:50,chat:{id:Number(actor),type:'private'},
   from:{id:900,is_bot:true}}}
});
const button=(result:{plan?:{inlineMarkup?:{inline_keyboard:readonly (readonly {text:string;callback_data:string}[])[]}}},needle:string)=>{
 const found=result.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.includes(needle));
 assert.ok(found,'missing button '+needle);return found.callback_data;
};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'whisper-owner-ui-'));
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>1_700_000_000_000);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'900',botUsername:'ManaratakBot',clock:()=>1_700_000_000_000});
 return {store,app,close:()=>rm(dir,{recursive:true,force:true})};
}
test('WHISPER-016 strict owner callback grammar and catalogue connection',()=>{
 assert.equal(ownerInlineConnection('mi:1:i:09:06'),'EDITOR');
 for(const value of ['wh:1:h','wh:1:v:abcdefabcdefabcdefabcdef',
  'wh:1:a:abcdefabcdefabcdefabcdef','wh:1:x:abcdefabcdefabcdefabcdef',
  'wh:1:c:abcdefabcdefabcdefabcdef:1'])assert.equal(validWhisperOwnerRoute(value),true,value);
 for(const value of ['wh:1:a:../../etc','wh:1:v:ABCDEFabcdefabcdefabcdef',
  'wh:1:c:abcdefabcdefabcdefabcdef:0','wh:1:h:x',
  'wh:1:v:abcdefabcdefabcdefabcdef:123'])assert.equal(validWhisperOwnerRoute(value),false,value);
});
for(const engine of ['json','sqlite'] as const){
 test('WHISPER-016 '+engine+': private owner draft → review → approve without group Telegram send',async()=>{
  const f=await fixture(engine);try{
   const menu=await f.app.handle(callback(1,'mi:1:i:09:06'));
   assert.equal(menu.status,'APPLIED');
   assert.match(menu.plan?.text??'',/الهمسات/);
   assert.equal(isValidTelegramInlineKeyboard(menu.plan?.inlineMarkup),true);
   const other=await f.app.handle(privateMsg(2,'/whisperfirst '+GROUP+' 2 10 This is private',MEMBER));
   assert.equal(other.status,'DENIED');
   const created=await f.app.handle(privateMsg(3,'/whisperfirst '+GROUP+' 2 10 This is private'));
   assert.equal(created.status,'APPLIED');
   assert.match(created.plan?.text??'',/This is private/);
   const draft=(await f.store.snapshot()).phase4Whispers?.messages[0];
   assert.equal(draft?.status,'DRAFT');
   const approve=button(created,'اعتماد');
   const result=await f.app.handle(callback(4,approve));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/لم تُنشر/);
   assert.equal((await f.store.snapshot()).phase4Whispers?.messages[0]?.status,'OPEN');
   assert.equal((await f.app.handle(callback(5,approve))).status,'DENIED');
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
   assert.equal((await f.store.snapshot()).operations.length,0);
  }finally{await f.close();}
 });
 test('WHISPER-016 '+engine+': owner cancellation needs second review and changed revision invalidates old choice',async()=>{
  const f=await fixture(engine);try{
   const created=await f.app.handle(privateMsg(8,'/whisperfirst '+GROUP+' 1 30 Secret'));
   const abort=button(created,'إغلاق');
   const review=await f.app.handle(callback(9,abort));
   assert.equal(review.status,'APPLIED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.messages[0]?.status,'DRAFT');
   const confirm=button(review,'تأكيد الإغلاق');
   assert.equal((await f.app.handle(callback(10,confirm))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.messages[0]?.status,'CLOSED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.messages[0]?.text,undefined);
   assert.equal((await f.app.handle(callback(11,confirm))).status,'DENIED');
  }finally{await f.close();}
 });
 test('WHISPER-016 '+engine+': old approval and invalid group cannot disclose draft',async()=>{
  const f=await fixture(engine);try{
   const created=await f.app.handle(privateMsg(20,'/whisperfirst '+GROUP+' 2 10 Sensitive & <text>'));
   const approve=button(created,'اعتماد');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.app.handle(callback(21,approve))).status,'DENIED');
   assert.equal((await f.app.handle(callback(22,'wh:1:h'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.messages[0]?.status,'DRAFT');
  }finally{await f.close();}
 });
}
