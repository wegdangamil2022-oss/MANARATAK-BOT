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
import {ButtonStudioService} from '../src/button-studio.js';
const CHAT='-100123',OTHER='-100456',NOW=1700000000000;
const event=(id:number,data:string,actor=100,group=false)=>({update_id:id,callback_query:{id:'delegation_'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}}}});
const message=(id:number,text:string,actor=100)=>({update_id:id,message:{message_id:id,date:1700000000,from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const select=(r:Result,text:string)=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(x=>x.text.includes(text));assert.ok(b,'missing '+text);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'delegation-inline-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now),admin=new EducationAdminFacade(store,policy,education,()=>now);
  await policy.approveChat('100',CHAT,['navigation','publishing','moderation']);await policy.approveChat('100',OTHER,['navigation','publishing','moderation']);
  const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),botId:'delegation-local',botUsername:'ManaratakBot',clock:()=>now,membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  async function begin(start:number){const root=await app().handle(event(start,'mi:1:i:03:01'));const groups=await app().handle(event(start+1,select(root,'إنشاء تفويض')));
   const caps=await app().handle(event(start+2,select(groups,CHAT)));const duration=await app().handle(event(start+3,select(caps,'نشر المحتوى')));return app().handle(event(start+4,select(duration,'7 يوم')));}
  return {store,policy,app,begin,time:(n:number)=>{now=n;},clock:()=>now,close:()=>rm(dir,{recursive:true,force:true})};
 }
 test('official assignment, capability, scope and temporary delegation entries open the shared local controls ('+engine+')',async()=>{
  const f=await fixture();try{
   for(const [index,entry] of ['02','04','05','07'].entries()){
    const route='mi:1:i:03:'+entry,view=await f.app().handle(event(500+index*3,route));
    assert.equal(view.status,'APPLIED');assert.match(view.plan!.text,/لا تثبت صلاحيات Telegram/);
    const groups=await f.app().handle(event(501+index*3,select(view,'إنشاء تفويض')));
    assert.ok(select(groups,CHAT));
    assert.equal((await f.app().handle(event(502+index*3,route,200))).status,'DENIED');
   }
   assert.equal((await f.store.snapshot()).grants.length,0);
  }finally{await f.close();}
 });
 test('owner grants and revokes one capability in one group with explicit single-use review ('+engine+')',async()=>{
  const f=await fixture();try{
   const prompt=await f.begin(1);assert.equal(prompt.status,'APPLIED');assert.ok(isValidTelegramInlineKeyboard(prompt.plan!.inlineMarkup));
   const review=await f.app().handle(message(6,'200'));assert.equal(review.status,'APPLIED');assert.equal((await f.store.snapshot()).grants.length,0);
   const confirmation=select(review,'تأكيد التفويض'),results=await Promise.all([f.app().handle(event(7,confirmation)),f.app().handle(event(8,confirmation))]);assert.equal(results.filter(r=>r.status==='APPLIED').length,1);
   let s=await f.store.snapshot();assert.equal(f.policy.has(s,'200','content.publish',CHAT,NOW),true);assert.equal(f.policy.has(s,'200','content.publish',OTHER,NOW),false);assert.equal(f.policy.has(s,'200','chat.manage',CHAT,NOW),false);
   const root=await f.app().handle(event(9,'mi:1:i:03:01')),detail=await f.app().handle(event(10,select(root,'👤 200'))),withdraw=await f.app().handle(event(11,select(detail,'مراجعة سحب')));
   const revoke=select(withdraw,'تأكيد السحب'),revokes=await Promise.all([f.app().handle(event(12,revoke)),f.app().handle(event(13,revoke))]);assert.equal(revokes.filter(r=>r.status==='APPLIED').length,1);
   s=await f.store.snapshot();assert.equal(f.policy.has(s,'200','content.publish',CHAT,NOW),false);assert.equal(s.grants.length,1);assert.equal(s.grants[0]!.revoked,true);assert.equal(s.deliveries.length,0);
   assert.equal((await f.app().handle(event(14,'od:1:g:0',200))).status,'DENIED');assert.equal((await f.app().handle(event(15,'od:1:g:0',100,true))).status,'DENIED');
  }finally{await f.close();}
 });
 test('delegation UI excludes unavailable capabilities and rejects forged scope choices ('+engine+')',async()=>{
  const f=await fixture();try{
   const root=await f.app().handle(event(80,'mi:1:i:03:01')),groups=await f.app().handle(event(81,select(root,'إنشاء تفويض'))),caps=await f.app().handle(event(82,select(groups,CHAT)));
   assert.equal(caps.plan!.inlineMarkup!.inline_keyboard.flat().some(b=>b.text==='سؤال المساعد'),false);
   const group=(await f.store.snapshot()).chats.find(c=>c.id===CHAT)!;
   assert.equal((await f.app().handle(event(83,'od:1:k:'+CHAT+':'+group.version+':0:a'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).grants.length,0);
  }finally{await f.close();}
 });
 test('delegated staff can operate only in the granted scope and lose access after revocation ('+engine+')',async()=>{
  const f=await fixture();try{
   let root=await f.app().handle(event(130,'mi:1:i:03:01')),groups=await f.app().handle(event(131,select(root,'إنشاء تفويض'))),caps=await f.app().handle(event(132,select(groups,CHAT))),duration=await f.app().handle(event(133,select(caps,'إدارة المجموعة')));
   await f.app().handle(event(134,select(duration,'1 يوم')));let review=await f.app().handle(message(135,'200'));await f.app().handle(event(136,select(review,'تأكيد التفويض')));
   const staff=await f.app().handle(message(137,'/staffinline',200));assert.equal(staff.status,'APPLIED');const choices=staff.plan!.inlineMarkup!.inline_keyboard.flat();assert.ok(choices.some(b=>b.text.includes(CHAT)));assert.equal(choices.some(b=>b.text.includes(OTHER)),false);
   const other=(await f.store.snapshot()).chats.find(c=>c.id===OTHER)!;assert.equal((await f.app().handle(event(138,'ms:1:g:'+OTHER+':'+other.version+':0',200))).status,'DENIED');
   root=await f.app().handle(event(139,'mi:1:i:03:01'));const detail=await f.app().handle(event(140,select(root,'👤 200')));review=await f.app().handle(event(141,select(detail,'مراجعة سحب')));await f.app().handle(event(142,select(review,'تأكيد السحب')));
   assert.equal((await f.app().handle(message(143,'/staffinline',200))).status,'DENIED');assert.equal((await f.app().handle(event(144,choices.find(b=>b.text.includes(CHAT))!.callback_data,200))).status,'DENIED');
  }finally{await f.close();}
 });
 test('switching between studio and delegation cancels pending text input ('+engine+')',async()=>{
  const f=await fixture();try{
   const studio=new ButtonStudioService(f.store,f.policy,f.clock),template=await studio.create('100','قالب');
   await f.app().handle(event(90,'st:1:i:'+template.id+':1:TEXT'));assert.equal((await f.store.snapshot()).buttonStudio!.inputs.length,1);
   await f.app().handle(event(91,'od:1:g:0'));assert.equal((await f.store.snapshot()).buttonStudio!.inputs.length,0);
   await f.app().handle(message(92,'200'));assert.equal((await f.store.snapshot()).buttonStudio!.templates[0]!.draft.text,'رسالة جديدة');
   await f.begin(100);await f.app().handle(event(105,'mi:1:i:10:16'));await f.app().handle(message(106,'300'));
   assert.equal((await f.store.snapshot()).grants.length,0);assert.equal((await f.store.snapshot()).callbacks.some(c=>c.action.startsWith('delegation.input:')&&c.used===false&&c.revoked===false),false);
  }finally{await f.close();}
 });
 test('ambiguous restored grant history cannot produce an approval or usable revoke button ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.policy.grant('100','200','content.publish',CHAT,NOW+86400000);await f.store.transaction(s=>{s.grants.push(structuredClone(s.grants[0]!));});
   await f.begin(110);assert.equal((await f.app().handle(message(115,'200'))).status,'DENIED');
   const root=await f.app().handle(event(116,'mi:1:i:03:01')),detail=await f.app().handle(event(117,select(root,'👤 200')));
   assert.equal(detail.plan!.inlineMarkup!.inline_keyboard.flat().some(x=>x.text.includes('سحب التفويض')),false);assert.equal(f.policy.has(await f.store.snapshot(),'200','content.publish',CHAT,NOW),false);
  }finally{await f.close();}
 });
 test('delegation grant rejects changed group, altered flags, expired inputs and nonnumeric or owner targets ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.begin(20);assert.equal((await f.app().handle(message(25,'100'))).status,'DENIED');assert.equal((await f.app().handle(message(26,'not-a-user'))).status,'DENIED');
   let review=await f.app().handle(message(27,'200'));await f.policy.revokeChat('100',CHAT);assert.equal((await f.app().handle(event(28,select(review,'تأكيد التفويض')))).status,'DENIED');assert.equal((await f.store.snapshot()).grants.length,0);
   await f.policy.approveChat('100',CHAT,['navigation','publishing']);await f.begin(30);review=await f.app().handle(message(35,'200'));const bad=select(review,'تأكيد التفويض');await f.store.transaction(s=>{s.callbacks.find(c=>c.ref==='c_'+bad.slice(7))!.used='false' as unknown as boolean;});assert.equal((await f.app().handle(event(36,bad))).status,'DENIED');
   await f.begin(40);f.time(NOW+600000);assert.equal((await f.app().handle(message(45,'300'))).status,'DENIED');assert.equal((await f.store.snapshot()).grants.length,0);
  }finally{await f.close();}
 });
 test('revoke review becomes stale if the grant was replaced or the owner dashboard closes ('+engine+')',async()=>{
  const f=await fixture();try{
   await f.begin(50);let review=await f.app().handle(message(55,'200'));await f.app().handle(event(56,select(review,'تأكيد التفويض')));
   let root=await f.app().handle(event(57,'mi:1:i:03:01')),detail=await f.app().handle(event(58,select(root,'👤 200'))),old=await f.app().handle(event(59,select(detail,'مراجعة سحب')));
   await f.policy.revokeGrant('100','200','content.publish',CHAT);await f.policy.grant('100','200','content.publish',CHAT,NOW+86400000);
   assert.equal((await f.app().handle(event(60,select(old,'تأكيد السحب')))).status,'DENIED');assert.equal(f.policy.has(await f.store.snapshot(),'200','content.publish',CHAT,NOW),true);
   root=await f.app().handle(event(61,'mi:1:i:03:01'));detail=await f.app().handle(event(62,select(root,'👤 200')));
   const currentButtons=root.plan!.inlineMarkup!.inline_keyboard.flat().filter(x=>x.text.includes('👤 200'));if(!detail.plan?.text.includes('ساري زمنيًا'))detail=await f.app().handle(event(63,currentButtons[1]!.callback_data));
   review=await f.app().handle(event(64,select(detail,'مراجعة سحب')));await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});assert.equal((await f.app().handle(event(65,select(review,'تأكيد السحب')))).status,'DENIED');
   assert.equal(f.policy.has(await f.store.snapshot(),'200','content.publish',CHAT,NOW),true);
  }finally{await f.close();}
 });
}
