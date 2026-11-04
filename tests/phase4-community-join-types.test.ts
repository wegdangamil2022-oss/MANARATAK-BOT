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
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {defaultCommunityConfig,validCommunityConfig,validCommunityState,selectCommunityGreeting}
 from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen,validPhase4CommunityRoute}
 from '../src/phase4-community-ui.js';

const CHAT='-1009191919191',OWNER='100',STUDENT='301';
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-join-types-'));
 const file=join(dir,engine==='json'?'state.json':'state.sqlite');
 let now=Date.parse('2026-11-04T15:00:00.000Z');
 const clock=()=>now,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,CHAT,['navigation']);
 await policy.setPresence(CHAT,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy,clock);
 const app=new TelegramUpdateApplication({store,policy,community,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED',clock});
 const approve=async(request:Parameters<typeof community.pending>[1])=>
  community.approve(OWNER,(await community.pending(OWNER,request,CHAT)).id);
 const incoming=(updateId:number,adder:number,memberIds:number[])=>({
  update_id:updateId,message:{message_id:updateId,chat:{id:Number(CHAT),type:'supergroup',title:'منارتك <&>'},
   from:{id:adder,is_bot:false,first_name:'إضافة'},
   new_chat_members:memberIds.map((id,i)=>({id,is_bot:false,first_name:i===0?'سارة <&>':'علي &'}))}
 });
 return {dir,file,store,policy,community,app,approve,incoming,clock,
  setNow:(x:number)=>{now=x;},close:()=>rm(dir,{recursive:true,force:true})};
}
test('P4 WELCOME-001: precise join mode commands and route whitelist',()=>{
 assert.deepEqual(parsePhase4CommunityCommand('/welcomevariant '+CHAT+' SELF دخلت {العضو}'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'دخلت {العضو}'}});
 assert.deepEqual(parsePhase4CommunityCommand('/clearwelcomevariant '+CHAT+' BATCH'),
  {kind:'EDIT',chatId:CHAT,request:{kind:'WELCOME_VARIANT_CLEAR',joinKind:'BATCH'}});
 for(const invalid of ['/welcomevariant '+CHAT+' REMOVED unknown',
  '/welcomevariant '+CHAT+' SELF', '/clearwelcomevariant '+CHAT+' OTHER',
  '/welcomevariant '+CHAT+' self hello', '/welcomevariant 123 SELF hello'])
  assert.equal(parsePhase4CommunityCommand(invalid),null,invalid);
 assert.equal(validPhase4CommunityRoute('p4c:1:b:'+CHAT),true);
 for(const kind of ['s','a','m'])assert.equal(validPhase4CommunityRoute('p4c:1:b:'+CHAT+':'+kind),true);
 assert.equal(validPhase4CommunityRoute('p4c:1:b:'+CHAT+':x'),false);
});
test('P4 WELCOME-001: join variants are typed, bounded, preserve safe language fallback',()=>{
 const old=defaultCommunityConfig(CHAT);
 assert.equal(validCommunityConfig(old),true);
 assert.equal(selectCommunityGreeting(old,'welcome','SELF'),old.welcome.text);
 assert.equal(selectCommunityGreeting(old,'welcome','BATCH'),old.welcome.text);
 const configured={...old,welcomeByJoin:{SELF:'أهلًا {العضو}',BATCH:'نرحب بالجميع'},
  welcome:{...old.welcome,localized:{en:'Welcome {العضو}'}}};
 assert.equal(validCommunityConfig(configured),true);
 assert.equal(selectCommunityGreeting(configured,'welcome','SELF'),'أهلًا {العضو}');
 assert.equal(selectCommunityGreeting({...configured,language:'en'},'welcome','ADDED'),
  'Welcome {العضو}');
 assert.equal(selectCommunityGreeting(configured,'farewell'),'نتمنى لك التوفيق يا {العضو} 👋');
 for(const bad of [{OTHER:'x'},{SELF:'bad {secret}'},{SELF:' '},
  {SELF:'x'.repeat(801)},{SELF:'ok',ADDED:42},['unexpected']]){
  assert.equal(validCommunityConfig({...old,welcomeByJoin:bad}),false);
 }
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[]}),true);
});
for(const engine of ['json','sqlite'] as const){
 test('P4 WELCOME-001 '+engine+': owner-reviewed join templates persist, expire and clear safely',async()=>{
  const f=await setup(engine);
  try{
   await assert.rejects(f.community.pending(STUDENT,
    {kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'ممنوع'},CHAT),/COMMUNITY_OWNER_DENIED/);
   await assert.rejects(f.community.pending(OWNER,
    {kind:'WELCOME_VARIANT_SET',joinKind:'UNTRUSTED' as any,text:'bad'},CHAT),
    /COMMUNITY_JOIN_KIND_INVALID/);
   await assert.rejects(f.community.pending(OWNER,
    {kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'Injected {bad}'},CHAT),
    /COMMUNITY_CONFIG_INVALID|Unsupported state schema|COMMUNITY_TEMPLATE_INVALID/);
   const draft=await f.community.pending(OWNER,
    {kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'بنفسه {العضو}'},CHAT);
   assert.equal((await f.community.view(OWNER,CHAT)).welcomeByJoin,undefined);
   assert.match(f.community.preview(draft),/SELF/);
   await f.community.approve(OWNER,draft.id);
   assert.equal((await f.community.view(OWNER,CHAT)).welcomeByJoin?.SELF,'بنفسه {العضو}');
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.configs[0]?.welcomeByJoin?.SELF,
    'بنفسه {العضو}');
   const stale=await f.community.pending(OWNER,{kind:'WELCOME_VARIANT_CLEAR',joinKind:'SELF'},CHAT);
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'ADDED',text:'أضافه آخر'});
   await assert.rejects(f.community.approve(OWNER,stale.id),/COMMUNITY_DRAFT_NOT_FOUND|COMMUNITY_DRAFT_STALE/);
   await f.approve({kind:'WELCOME_VARIANT_CLEAR',joinKind:'SELF'});
   assert.equal((await f.community.view(OWNER,CHAT)).welcomeByJoin?.SELF,undefined);
   assert.equal((await f.community.view(OWNER,CHAT)).welcomeByJoin?.ADDED,'أضافه آخر');
   await f.approve({kind:'WELCOME_VARIANT_CLEAR',joinKind:'ADDED'});
   assert.equal((await f.community.view(OWNER,CHAT)).welcomeByJoin,undefined);
  }finally{await f.close();}
 });
 test('P4 WELCOME-001 '+engine+': Telegram service member events select SELF, ADDED, BATCH not student text',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'دخول ذاتي: {العضو}'});
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'ADDED',text:'عضو مضاف: {العضو}'});
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'BATCH',text:'مجموعة جديدة: {العضو}'});
   await f.approve({kind:'WELCOME_ON'});
   const self=await f.app.handle(f.incoming(101,301,[301]));
   assert.equal(self.status,'APPLIED');
   assert.equal(self.plan?.text,'دخول ذاتي: سارة &lt;&amp;&gt;');
   f.setNow(f.clock()+9000);
   const added=await f.app.handle(f.incoming(102,900,[302]));
   assert.equal(added.plan?.text,'عضو مضاف: سارة &lt;&amp;&gt;');
   f.setNow(f.clock()+9000);
   const batch=await f.app.handle(f.incoming(103,900,[303,304]));
   assert.equal(batch.plan?.text,'مجموعة جديدة: سارة &lt;&amp;&gt;، علي &amp;');
   assert.equal((await f.store.snapshot()).phase4Community?.receipts.length,3);
   const view=await phase4CommunityScreen(f.community,OWNER,'p4c:1:b:'+CHAT);
   assert.match(view?.text??'',/SELF|ADDED|BATCH/u);
   const initial=(await f.store.snapshot()).phase4Community;
   assert.equal(JSON.stringify(initial?.receipts).includes('سارة'),false);
  }finally{await f.close();}
 });
 test('P4 WELCOME-001 '+engine+': stale welcome send is cancelled if join-type template changes',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'أهلًا {العضو}'});
   await f.approve({kind:'WELCOME_ON'});
   const queued=await f.app.handle(f.incoming(221,301,[301]));
   assert.equal(queued.status,'APPLIED');assert.ok(queued.deliveryKey);
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'مرحبًا مجددًا {العضو}'});
   let calls=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{
    send:async()=>{calls++;return {status:'CONFIRMED' as const,messageId:1};}
   },f.clock);
   assert.equal((await dispatcher.dispatch(queued.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(calls,0);
   f.setNow(f.clock()+9000);
   const newResult=await f.app.handle(f.incoming(222,401,[401]));
   assert.equal(newResult.plan?.text,'مرحبًا مجددًا سارة &lt;&amp;&gt;');
  }finally{await f.close();}
 });
 test('P4 WELCOME-001 '+engine+': owner inline page routes remain private, edits require review',async()=>{
  const f=await setup(engine);
  try{
   const group=await phase4CommunityScreen(f.community,OWNER,'p4c:1:g:'+CHAT);
   assert.ok(group?.keyboard.inline_keyboard.flat().some(x=>x.callback_data==='p4c:1:b:'+CHAT));
   await assert.rejects(phase4CommunityScreen(f.community,STUDENT,'p4c:1:b:'+CHAT),
    /COMMUNITY_OWNER_DENIED/);
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'BATCH',text:'Welcome batch'});
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:b:'+CHAT);
   assert.match(screen?.text??'',/Welcome batch|BATCH/u);
   const clear=await phase4CommunityScreen(f.community,OWNER,'p4c:1:b:'+CHAT+':m');
   assert.ok(clear?.keyboard.inline_keyboard.flat().some(x=>x.callback_data.startsWith('p4c:1:c:')));
   assert.equal((await f.community.view(OWNER,CHAT)).welcomeByJoin?.BATCH,'Welcome batch');
   const action=clear?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith('p4c:1:c:'));
   await phase4CommunityScreen(f.community,OWNER,action!.callback_data);
   assert.equal((await f.community.view(OWNER,CHAT)).welcomeByJoin,undefined);
  }finally{await f.close();}
 });
}


for(const engine of ['json','sqlite'] as const){
 test('P4 WELCOME-001 '+engine+': chat_member transitions greet only actual new members, not promotions',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'SELF',text:'دخول: {العضو}'});
   await f.approve({kind:'WELCOME_VARIANT_SET',joinKind:'ADDED',text:'إضافة: {العضو}'});
   await f.approve({kind:'WELCOME_ON'});
   const member=(id:number,adder:number,target:number,oldStatus:string,newStatus:string,
    override:Record<string,unknown>={})=>({update_id:id,chat_member:{
    chat:{id:Number(CHAT),type:'supergroup',title:'منارتك'},
    from:{id:adder,is_bot:false,first_name:'مشرف'},
    date:Math.floor(f.clock()/1000),
    old_chat_member:{status:oldStatus,user:{id:target,is_bot:false,first_name:'مشارك'}},
    new_chat_member:{status:newStatus,user:{id:target,is_bot:false,first_name:'مشارك <&>'}},
    ...override
   }});
   const a=await f.app.handle(member(3000,501,501,'left','member'));
   assert.equal(a.status,'APPLIED');assert.equal(a.plan?.text,'دخول: مشارك &lt;&amp;&gt;');
   f.setNow(f.clock()+9000);
   const b=await f.app.handle(member(3001,900,502,'kicked','member',{via_join_request:true}));
   assert.equal(b.status,'APPLIED');assert.equal(b.plan?.text,'إضافة: مشارك &lt;&amp;&gt;');
   f.setNow(f.clock()+9000);
   const promotion=await f.app.handle(member(3002,900,503,'member','administrator'));
   assert.equal(promotion.plan,undefined);
   const kick=await f.app.handle(member(3003,900,504,'member','kicked'));
   assert.equal(kick.plan,undefined);
   const malformed=member(3004,900,505,'left','member');
   malformed.chat_member.new_chat_member.user.id=506;
   assert.equal((await f.app.handle(malformed)).plan,undefined);
   const state=await f.store.snapshot();
   assert.equal(state.phase4Community?.receipts.length,2);
  }finally{await f.close();}
 });
 test('P4 WELCOME-001 '+engine+': Telegram chat_member and service message cannot double-welcome',async()=>{
  const f=await setup(engine);
  try{
   await f.approve({kind:'WELCOME_ON'});
   const chatMember={update_id:3080,chat_member:{
    chat:{id:Number(CHAT),type:'supergroup',title:'منارتك'},
    from:{id:601,is_bot:false},date:Math.floor(f.clock()/1000),
    old_chat_member:{status:'left',user:{id:601,is_bot:false}},
    new_chat_member:{status:'member',user:{id:601,is_bot:false,first_name:'طالب'}}
   }};
   assert.ok((await f.app.handle(chatMember)).deliveryKey);
   f.setNow(f.clock()+9000);
   assert.equal((await f.app.handle(f.incoming(3081,601,[601]))).plan,undefined);
   const stale={...chatMember,update_id:3082,chat_member:{
    ...chatMember.chat_member,from:{id:602,is_bot:false},
    date:Math.floor(f.clock()/1000)-901,
    old_chat_member:{status:'left',user:{id:602,is_bot:false}},
    new_chat_member:{status:'member',user:{id:602,is_bot:false,first_name:'طالب'}}
   }};
   assert.equal((await f.app.handle(stale)).plan,undefined);
   assert.equal((await f.store.snapshot()).phase4Community?.receipts.length,1);
  }finally{await f.close();}
 });
}
