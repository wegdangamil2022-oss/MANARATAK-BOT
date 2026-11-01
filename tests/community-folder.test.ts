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
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramReplyDispatcher,TelegramBotApiTextSender,validTelegramReplyJob} from '../src/telegram-replies.js';
import {communityFolderURL,validCommunityFolders} from '../src/community-folder-model.js';
const NOW=1700000000000,GROUP='-100100',URL='https://t.me/addlist/Approved_Folder-123';
test('community folder URLs are exact Telegram addlist URLs, with no alternate hosts, query or encoded paths',()=>{
 assert.ok(communityFolderURL(URL));for(const url of ['http://t.me/addlist/a','https://t.me.evil.com/addlist/a','https://t.me@evil.com/addlist/a','https://t.me/addlist/a?x=1','https://t.me/addlist/%61','https://t.me/addlist/../a',URL+'#x',URL+'\n'])assert.equal(communityFolderURL(url),false);
 assert.ok(validCommunityFolders([{chatId:GROUP,url:URL,enabled:true,revision:1}]));assert.equal(validCommunityFolders([{chatId:GROUP,url:URL,enabled:'true',revision:1}]),false);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'community-folder-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=0;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now),membership=new FakeMembershipGateway();await policy.approveChat('100',GROUP,['navigation','verification']);for(const c of ['-100200','-100201','-100202'])await policy.approveChat('100',c,['verification']);
  const gate=new SubscriptionGate(store,policy,membership,new ModerationService(store,policy,new FakeModerationGateway()),()=>now);await gate.configure('100',GROUP,['-100200','-100201','-100202'],'AT_LEAST',undefined,2);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),subscription:gate,clock:()=>now,botId:'community',botUsername:'ManaratakBot',ownerMenuMode:'inline',studentMenuMode:'inline',membership:async()=>{throw Error('NETWORK_FORBIDDEN');}});
  const click=(data:string,actor=100,group=false)=>app.handle({update_id:++id,callback_query:{id:'folder-'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100999:actor,type:group?'supergroup':'private'}}}});
  const text=(text:string,actor=100)=>app.handle({update_id:++id,message:{message_id:id,from:{id:actor,is_bot:false},chat:{id:actor,type:'private'},text}});
  return {store,policy,membership,click,text,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 type Result=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['click']>>;
 const buttons=(r:Result)=>r.plan?.studioMarkup?.inline_keyboard.flat()??r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
 const choose=(r:Result,label:string)=>{const b=buttons(r).find(b=>b.text.startsWith(label));assert.ok(b&&'callback_data' in b,label+' '+r.reason);return b.callback_data;};
 async function save(f:Awaited<ReturnType<typeof fixture>>){let r=await f.click('mi:1:i:04:03');r=await f.click(choose(r,'👥 '+GROUP));await f.click(choose(r,'✏️ الرابط'));r=await f.text(URL);assert.equal(f.store&&(await f.store.snapshot()).communityFolders,undefined);return f.click(choose(r,'✅ تأكيد'));}
 test(engine+' owner saves a reviewed folder link; student checks actual required membership and disable requires confirmation',async()=>{
  const f=await fixture();try{
   let r=await save(f);assert.equal((await f.store.snapshot()).communityFolders![0]!.url,URL);assert.equal(r.plan!.editMessageId,55);
   assert.equal(choose(await f.text('/start',300),'📁 مجلدات المجتمع'),'fj:1:h');
   let joined=await f.click('fj:1:h',300);joined=await f.click(choose(joined,'📁 '+GROUP),300);assert.equal(buttons(joined).find(b=>'url' in b)?.url,URL);assert.ok(joined.plan!.text.includes('لا تثبت'));
   f.membership.set('-100200','300','MEMBER');f.membership.set('-100201','300','MEMBER');f.membership.set('-100202','300','UNKNOWN');joined=await f.click(choose(joined,'✅ تحقق'),300);assert.ok(joined.plan!.text.includes('تحقق شرط الاشتراك'));
   r=await f.click(choose(r,'⏸️ تعطيل'));assert.equal((await f.store.snapshot()).communityFolders![0]!.enabled,true);await f.click(choose(r,'✅ تأكيد'));assert.equal((await f.store.snapshot()).communityFolders![0]!.enabled,false);assert.equal(buttons(await f.click('fj:1:h',300)).some(b=>b.text==='📁 '+GROUP),false);
   assert.equal(buttons(await f.text('/start',300)).some(b=>b.text==='📁 مجلدات المجتمع'),false);
  }finally{await f.close();}
 });
 test(engine+' unsafe input, copied selectors, cancellation, expiry and changed approval cannot save a folder',async()=>{
  const f=await fixture();try{
   let r=await f.click('mi:1:i:04:03'),route=choose(r,'👥 '+GROUP);assert.equal((await f.click(route,300)).status,'DENIED');assert.equal((await f.click(route,100,true)).status,'DENIED');r=await f.click(route);await f.click(choose(r,'✏️ الرابط'));r=await f.text('https://evil.com/addlist/x');assert.ok(r.plan!.text.includes('غير صالح'));assert.equal((await f.store.snapshot()).communityFolders,undefined);r=await f.text(URL);route=choose(r,'✅ تأكيد');await f.click('mi:1:h');assert.equal((await f.click(route)).status,'DENIED');
   r=await f.click('mi:1:i:04:03');r=await f.click(choose(r,'👥 '+GROUP));await f.click(choose(r,'✏️ الرابط'));r=await f.text(URL);route=choose(r,'✅ تأكيد');f.time(NOW+120000);assert.equal((await f.click(route)).status,'DENIED');assert.equal((await f.store.snapshot()).communityFolders,undefined);
  }finally{await f.close();}
 });
 test(engine+' public folder selectors and queued join screens are invalidated by withdrawal or source changes',async()=>{
  const f=await fixture();try{
   await save(f);let r=await f.click('fj:1:h',300);const route=choose(r,'📁 '+GROUP);assert.equal((await f.click(route,301)).status,'DENIED');r=await f.click(route,300);let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);
   await f.policy.revokeChat('100',GROUP);assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);assert.equal((await f.click(choose(r,'✅ تحقق'),300)).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' folders paginate; verify distinguishes insufficient, unknown, and owner-exempt membership',async()=>{
  const f=await fixture();try{
   await save(f);for(let i=0;i<9;i++){const id=String(-100300-i);await f.policy.approveChat('100',id,['navigation','verification']);await f.store.transaction(s=>{s.subscriptionRequirements.push({chatId:id,channelIds:['-100200'],mode:'ALL',version:1});s.communityFolders!.push({chatId:id,url:URL,enabled:true,revision:1});});}
   let r=await f.click('fj:1:h',300);assert.equal(buttons(r).filter(b=>b.text.startsWith('📁 -')).length,8);r=await f.click(choose(r,'➡️ التالي'),300);assert.equal(buttons(r).filter(b=>b.text.startsWith('📁 -')).length,2);r=await f.click(choose(r,'📁 -'),300);r=await f.click(choose(r,'↩️ المجلدات'),300);assert.ok(r.plan!.text.includes('صفحة 2 من 2'));
   r=await f.click('fj:1:h',300);r=await f.click(choose(r,'📁 '+GROUP),300);for(const id of ['-100200','-100201','-100202'])f.membership.set(id,'300','NOT_MEMBER');r=await f.click(choose(r,'✅ تحقق'),300);assert.ok(r.plan!.text.includes('لم يتحقق العدد'));f.membership.set('-100200','300','UNKNOWN');r=await f.click(choose(r,'✅ تحقق'),300);assert.ok(r.plan!.text.includes('تعذر التحقق'));
   r=await f.click('fj:1:h');r=await f.click(choose(r,'📁 '+GROUP));r=await f.click(choose(r,'✅ تحقق'));assert.ok(r.plan!.text.includes('المالك مستثنى'));
  }finally{await f.close();}
 });
 test(engine+' native folder URL and verify callbacks serialize through the guarded dispatcher and never send twice',async()=>{
  const f=await fixture();try{
   await save(f);let r=await f.click('fj:1:h',300);r=await f.click(choose(r,'📁 '+GROUP),300);let calls=0,body:Record<string,unknown>={};
   const request=(async(url:unknown,init:RequestInit)=>{calls++;assert.ok(String(url).endsWith('/editMessageText'));body=JSON.parse(String(init.body));return Response.json({ok:true,result:{message_id:55,chat:{id:300}}});}) as typeof fetch;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,new TelegramBotApiTextSender('123456:'+'a'.repeat(35),request),()=>NOW);assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'CONFIRMED');assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'SENT');assert.equal(calls,1);assert.equal((body.reply_markup as {inline_keyboard:{url?:string}[][]}).inline_keyboard[0]![0]!.url,URL);
   assert.equal((await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===r.deliveryKey)!.communityAccess,undefined);
  }finally{await f.close();}
 });
 test(engine+' public folder callback expiry, duplicates and education revocation fail closed',async()=>{
  const f=await fixture();try{
   await save(f);let r=await f.click('fj:1:h',300),route=choose(r,'📁 '+GROUP),ref='folder-public:'+route.slice(5);const saved=(await f.store.snapshot()).callbacks.find(c=>c.ref===ref)!;
   await f.store.transaction(s=>{s.callbacks.push({...saved});});assert.equal((await f.click(route,300)).status,'DENIED');r=await f.click('fj:1:h',300);route=choose(r,'📁 '+GROUP);f.time(NOW+120000);assert.equal((await f.click(route,300)).status,'DENIED');f.time(NOW);
   r=await f.click('fj:1:h',300);route=choose(r,'📁 '+GROUP);await f.store.transaction(s=>{s.privateFeatures['education.navigate']=false;});assert.equal((await f.click(route,300)).status,'DENIED');assert.equal((await f.click('fj:1:h',300)).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' community proof cannot be retagged and folder edits do not invalidate unrelated private library replies',async()=>{
  const f=await fixture();try{
   await save(f);let r=await f.click('fj:1:h',300);r=await f.click(choose(r,'📁 '+GROUP),300);const job=(await f.store.snapshot()).telegramReplyJobs!.find(j=>j.updateKey===r.deliveryKey)!;assert.equal(job.privateReplyKind,'COMMUNITY_SCOPED');assert.ok(validTelegramReplyJob(job));assert.equal(validTelegramReplyJob({...job,privateReplyKind:'LOCAL'}),false);assert.equal(validTelegramReplyJob({...job,communityAccess:undefined}),false);assert.equal(validTelegramReplyJob({...job,privateLibraryAccess:job.communityAccess}),false);
   const library=await f.text('/studentinline',300);assert.ok(library.deliveryKey);await f.store.transaction(s=>{s.communityFolders![0]!.enabled=false;s.communityFolders![0]!.revision++;});let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);
   assert.equal((await dispatcher.dispatch(r.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal((await dispatcher.dispatch(library.deliveryKey!)).status,'CONFIRMED');assert.equal(sent,1);
  }finally{await f.close();}
 });
 test(engine+' restored duplicate folder records and malformed URLs are rejected atomically',async()=>{
  const f=await fixture();try{
   await save(f);await assert.rejects(f.store.transaction(s=>{s.communityFolders!.push({...s.communityFolders![0]!});}));await assert.rejects(f.store.transaction(s=>{s.communityFolders![0]!.url='https://evil.com/addlist/a';}));assert.equal((await f.store.snapshot()).communityFolders!.length,1);assert.equal((await f.store.snapshot()).communityFolders![0]!.url,URL);
  }finally{await f.close();}
 });
}
