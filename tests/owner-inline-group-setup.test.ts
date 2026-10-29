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
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,CHAT='-100123';
const cb=(i:number,data:string,actor=100,group=false)=>({update_id:i,callback_query:{id:'setup_'+i,from:{id:actor,is_bot:false},data,message:{message_id:77,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}}}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const button=(r:Result,text:string)=>{assert.ok(isValidTelegramInlineKeyboard(r.plan?.inlineMarkup));const b=r.plan!.inlineMarkup!.inline_keyboard.flat().find(x=>x.text.includes(text));assert.ok(b,'missing '+text);assert.ok(Buffer.byteLength(b.callback_data)<=64);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'group-setup-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy);await policy.approveChat('100',CHAT,['moderation']);
  const app=()=>new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education),faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),botId:'group-setup',botUsername:'ManaratakBot',clock:()=>now,membership:async()=>{throw Error('no network');}});
  return {store,policy,app,setTime:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 async function begin(f:Awaited<ReturnType<typeof fixture>>){
  const home=await f.app().handle(cb(1,'mi:1:i:01:01'));
  const group=await f.app().handle(cb(2,button(home,CHAT)));
  return f.app().handle(cb(3,button(group,'معالج إعداد')));
 }
 test(engine+' setup resumes, tests and commits local monitoring once',async()=>{const f=await fixture();try{
  const first=await begin(f);assert.match(first.plan!.text,/لم تُفحص حيًا/);
  assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
  const step1=await f.app().handle(cb(4,button(first,'متابعة الإعداد')));
  const duplicateStart=await f.app().handle(cb(5,'gw:1:b:'+CHAT+':1:0'));assert.match(duplicateStart.plan!.text,/استُعيد/);
  assert.equal(button(duplicateStart,'قالب فارغ'),button(step1,'قالب فارغ'));
  const chosen=await f.app().handle(cb(6,button(step1,'مراجعة الروابط')));
  const reviewed=await f.app().handle(cb(7,button(chosen,'اختبار القالب')));assert.match(reviewed.plan!.text,/نجح اختبار/);
  const confirm=button(reviewed,'تأكيد تشغيل');
  const results=await Promise.all([f.app().handle(cb(8,confirm)),f.app().handle(cb(9,confirm))]);
  assert.equal(results.filter(r=>r.status==='APPLIED').length,1);
  const state=await f.store.snapshot();assert.equal(state.protectionPolicies!.length,1);assert.equal(state.protectionPolicies![0]!.policy.mode,'MONITOR');
  assert.equal(state.protectionPolicies![0]!.policy.rules[0]!.kind,'LINK');assert.equal(state.audit.filter(a=>a.reason==='GROUP_SETUP_MONITOR_SAVED').length,1);
  assert.match(results.find(r=>r.status==='APPLIED')!.plan!.text,/لم تُفحص حقوق Telegram/);
 }finally{await f.close();}});
 test(engine+' back, cancellation and fresh group policy fence prevent old confirmation',async()=>{const f=await fixture();try{
  const first=await begin(f);const one=await f.app().handle(cb(4,button(first,'متابعة الإعداد')));
  const selected=await f.app().handle(cb(5,button(one,'قالب فارغ')));
  const back=await f.app().handle(cb(6,button(selected,'السابق')));assert.ok(button(back,'قالب فارغ'));
  assert.equal((await f.app().handle(cb(7,button(selected,'اختبار القالب')))).status,'DENIED');
  const chosen=await f.app().handle(cb(8,button(back,'قالب فارغ')));
  const reviewed=await f.app().handle(cb(9,button(chosen,'اختبار القالب')));
  await f.policy.revokeChat('100',CHAT);
  assert.equal((await f.app().handle(cb(10,button(reviewed,'تأكيد تشغيل')))).status,'DENIED');
  assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
 }finally{await f.close();}});
 test(engine+' rejects foreign users, expired setup, forged callbacks and existing policy',async()=>{const f=await fixture();try{
  const first=await begin(f),next=button(first,'متابعة الإعداد');
  assert.equal((await f.app().handle(cb(4,next,200))).status,'DENIED');
  assert.equal((await f.app().handle(cb(5,next,100,true))).status,'DENIED');
  assert.equal((await f.app().handle(cb(6,'gw:1:b:'+CHAT+':1:0:extra'))).status,'DENIED');
  f.setTime(NOW+1800001);assert.equal((await f.app().handle(cb(7,next))).status,'DENIED');
  assert.equal((await f.store.snapshot()).protectionPolicies,undefined);
 }finally{await f.close();}});
 test(engine+' changed protection configuration cannot be overwritten',async()=>{const f=await fixture();try{
  const first=await begin(f),one=await f.app().handle(cb(4,button(first,'متابعة الإعداد')));
  const chosen=await f.app().handle(cb(5,button(one,'قالب فارغ'))),reviewed=await f.app().handle(cb(6,button(chosen,'اختبار القالب')));
  await f.store.transaction(s=>{s.protectionPolicies=[{policy:{chatId:CHAT,revision:1,mode:'OFF',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},chatPolicyVersion:1,updatedBy:'100',updatedAt:NOW}];});
  assert.equal((await f.app().handle(cb(7,button(reviewed,'تأكيد تشغيل')))).status,'DENIED');
  assert.equal((await f.store.snapshot()).protectionPolicies![0]!.policy.mode,'OFF');
 }finally{await f.close();}});
}
