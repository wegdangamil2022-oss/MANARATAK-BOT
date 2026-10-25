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

const OWNER='100',GROUP='-100123',TIME=1_700_000_000_000;
const cb=(i:number,user:number,data:string,chatKind:'private'|'supergroup'='private')=>({
 update_id:i,callback_query:{id:'fuse_'+i,from:{id:user,is_bot:false},data,
  message:{message_id:57,from:{id:999,is_bot:true},
   chat:{id:chatKind==='private'?user:Number(GROUP),type:chatKind}}
 }
});
for(const engine of ['json','sqlite'] as const){
 test('owner protection-policy button shows real aggregated rate caps without identities ('+engine+')',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manaratak-fuse-panel-'));
  try{
   const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
   const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
   const admin=new EducationAdminFacade(store,policy,education);
   const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
   const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,
    botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>TIME});
   await policy.approveChat(OWNER,GROUP,['moderation','navigation']);
   await store.transaction(s=>{
    const version=s.chats[0]!.version;
    s.moderationOperations.push(...['CONFIRMED','UNKNOWN_OUTCOME','CANCELLED'].map((status,i)=>({
     id:'secret-'+i,actorId:'333',chatId:GROUP,memberId:String(500+i),
     kind:'BAN' as const,reasonFingerprint:'PRIVATE-REF',policyVersion:version,
     status:status as 'CONFIRMED'|'UNKNOWN_OUTCOME'|'CANCELLED',
     createdAt:TIME-1000
    })));
   });
   const before=await store.snapshot();
   const o=await app.handle(cb(1,100,'mi:1:i:02:15'));
   assert.equal(o.status,'APPLIED');
   assert.equal(o.plan?.editMessageId,57);
   assert.equal(isValidTelegramInlineKeyboard(o.plan?.inlineMarkup),true);
   const text=o.plan?.text??'';
   assert.match(text,/حدود العقوبات/);
   assert.match(text,/5 إجراءات/);
   assert.match(text,/12 إجراء/);
   assert.match(text,/30 إجراء/);
   assert.match(text,/آخر 10 دقائق: 2/);
   assert.match(text,/آخر 24 ساعة: 2/);
   assert.match(text,/مجهولة النتيجة: 1/);
   assert.doesNotMatch(text,/333|500|501|502|PRIVATE-REF|secret-/);
   assert.equal(o.plan?.inlineMarkup?.inline_keyboard.flat().some(b=>b.callback_data==='mi:1:s:02:1'),true);
   const after=await store.snapshot();
   assert.deepEqual(after.moderationOperations,before.moderationOperations);
   assert.equal((await app.handle(cb(2,300,'mi:1:i:02:15'))).status,'DENIED');
   assert.equal((await app.handle(cb(3,100,'mi:1:i:02:15','supergroup'))).status,'DENIED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
