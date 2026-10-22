import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {LocalFAQKnowledgeSource,B6AnswerPreflight,type KnowledgeSourcePort} from '../src/b6-approved-answer-preflight.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
const OWNER='100',STUDENT=300,GROUP='-100555',CHANNEL='-100556';
const QUESTION='ما شروط المنحة؟',ANSWER='شروط معتمدة <راجعتها> & موثقة';
const msg=(updateId:number,actor:number,text:string,group=false)=>({
 update_id:updateId,message:{message_id:updateId,from:{id:actor,is_bot:false},
 chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},text}
});
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'b6-telegram-approved-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','assistant','verification']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
 await policy.configurePrivateAI(OWNER,'ALL_OPT_IN');
 const resourceId=randomUUID(),groupResourceId=randomUUID();
 await store.transaction(s=>{
  s.privateFeatures['content.upload']=true;
  s.educationCategories.push(
   {id:'private',scope:'private',parentId:null,title:'منح',order:0,enabled:true},
   {id:'grants',scope:GROUP,parentId:null,title:'منح المجموعة',order:0,enabled:true}
  );
  for(const [id,scope,category] of [[resourceId,'private','private'],[groupResourceId,GROUP,'grants']] as const)
   s.educationResources.push({id,scope,categoryId:category,title:'منحة',university:'جامعة',
    cycle:'2027',degree:'Bachelor',seats:null,sourceImportId:randomUUID(),
    sourceLocator:'fixture',reviewedBy:OWNER,status:'PUBLISHED'});
 });
 const a=await faq.submit(OWNER,'private',{question:QUESTION,answer:ANSWER,sourceResourceId:resourceId});
 const b=await faq.submit(OWNER,GROUP,{question:QUESTION,answer:'جواب المجموعة فقط',sourceResourceId:groupResourceId});
 await faq.approve(OWNER,a.id);await faq.approve(OWNER,b.id);
 const knowledge=new LocalFAQKnowledgeSource(store);
 const planner=(source:KnowledgeSourcePort=knowledge)=>new B6AnswerPreflight(store,policy,faq,source);
 const membership=new FakeMembershipGateway();
 const subscription=new SubscriptionGate(store,policy,membership,
  new ModerationService(store,policy,new FakeModerationGateway()));
 const app=(withB6:boolean,source?:KnowledgeSourcePort,checkSubscription=false)=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,botId:'main',botUsername:'ManaratakBot',
  membership:async()=> 'UNKNOWN',...(withB6?{answerPreflight:planner(source)}:{}),
  ...(checkSubscription?{subscription}:{})
 });
 return {store,policy,education,faq,knowledge,planner,app,subscription,membership,resourceId,groupResourceId,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': private explicit /ask uses only reviewed FAQ while preserving /faq behavior',async()=>{
  const f=await setup(engine);try{
   const before=await f.store.snapshot();
   const result=await f.app(true).handle(msg(1,STUDENT,'/ask '+QUESTION));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/شروط معتمدة &lt;راجعتها&gt; &amp; موثقة/);
   assert.match(result.plan?.text??'',/ليست|غير مولدة|غير مُولدة/);
   const fallback=await f.app(false).handle(msg(2,STUDENT,'/ask '+QUESTION));
   assert.equal(fallback.status,'IGNORED');
   assert.equal(fallback.plan,undefined);
   const faq=await f.app(false).handle(msg(3,STUDENT,'/faq '+QUESTION));
   assert.equal(faq.status,'APPLIED');
   assert.match(faq.plan?.text??'',/شروط معتمدة/);
   assert.deepEqual((await f.store.snapshot()).educationResources,before.educationResources);
   assert.deepEqual((await f.store.snapshot()).deliveries,before.deliveries);
  }finally{await f.close();}
 });
 test('B6 '+engine+': private AI OFF denies /ask even while /faq remains available',async()=>{
  const f=await setup(engine);try{
   await f.policy.configurePrivateAI(OWNER,'OFF');
   const denied=await f.app(true).handle(msg(10,STUDENT,'/ask '+QUESTION));
   assert.equal(denied.status,'DENIED');
   assert.equal(denied.plan,undefined);
   const faq=await f.app(true).handle(msg(11,STUDENT,'/faq '+QUESTION));
   assert.equal(faq.status,'APPLIED');
   assert.match(faq.plan?.text??'',/شروط معتمدة/);
  }finally{await f.close();}
 });
 test('B6 '+engine+': mentioned approved group scope only returns its own reviewed source',async()=>{
  const f=await setup(engine);try{
   const result=await f.app(true).handle(msg(20,STUDENT,'/ask@ManaratakBot '+QUESTION,true));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/جواب المجموعة فقط/);
   assert.doesNotMatch(result.plan?.text??'',/شروط معتمدة|&lt;راجعتها&gt;/);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': unknown/private question does not trigger generative fallback or fabricate response',async()=>{
  const f=await setup(engine);try{
   const result=await f.app(true).handle(msg(30,STUDENT,'/ask لا توجد إجابة معتمدة'));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/لم نجد|لم نعثر|لا توجد/);
   assert.doesNotMatch(result.plan?.text??'',/شروط معتمدة/);
   const group=await f.app(true).handle(msg(31,STUDENT,
    '/ask@ManaratakBot سؤال غير معروف',true));
   assert.equal(group.status,'DENIED');
   assert.equal(group.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': revoking group policy during knowledge-port wait prevents Telegram reply planning',async()=>{
  const f=await setup(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r);
   const paused=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async q=>{
    const candidate=await f.knowledge.lookup(q);entered();await paused;return candidate;
   }};
   const pending=f.app(true,source).handle(msg(40,STUDENT,'/ask@ManaratakBot '+QUESTION,true));
   await started;await f.policy.revokeChat(OWNER,GROUP);release();
   const result=await pending;
   assert.equal(result.status,'DENIED');
   assert.equal(result.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': no source adapter option leaves previous approved group /ask handler unchanged',async()=>{
  const f=await setup(engine);try{
   const result=await f.app(false).handle(msg(50,STUDENT,'/ask@ManaratakBot '+QUESTION,true));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/جواب المجموعة فقط/);
   assert.doesNotMatch(result.plan?.text??'',/شروط معتمدة/);
  }finally{await f.close();}
 });
}


const mentionUpdate=(id:number,text:string,entities:unknown,extra:Record<string,unknown>={})=>{
 const base=msg(id,STUDENT,text,true);
 return {...base,message:{...base.message,entities,...extra}};
};
for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': genuine Telegram MessageEntity mention gives the group approved answer',async()=>{
  const f=await setup(engine);try{
   const text='@ManaratakBot '+QUESTION;
   const result=await f.app(true).handle(mentionUpdate(200,text,[
    {type:'mention',offset:0,length:'@ManaratakBot'.length}
   ]));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/جواب المجموعة فقط/);
   assert.doesNotMatch(result.plan?.text??'',/شروط معتمدة/);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': group mention is case insensitive and supports UTF-16 emoji inside question',async()=>{
  const f=await setup(engine);try{
   const text='@manaratakbot '+QUESTION+' 😀';
   const result=await f.app(true).handle(mentionUpdate(201,text,[
    {type:'mention',offset:0,length:13},
    {type:'custom_emoji',offset:text.length-2,length:2,custom_emoji_id:'fake'}
   ]));
   // Valid explicit mention reaches approved-knowledge matching even when that
   // extra emoji makes this question unmatched; it never generates a fallback.
   assert.equal(result.status,'DENIED');
   assert.equal(result.reason,'B6_NO_APPROVED_SOURCE');
  }finally{await f.close();}
 });
 test('B6 '+engine+': raw lookalike mention with no Telegram entity is ignored',async()=>{
  const f=await setup(engine);try{
   const text='@ManaratakBot '+QUESTION;
   let id=210;
   for(const entities of [undefined,[],[{type:'bold',offset:0,length:13}]]){
    const r=await f.app(true).handle(mentionUpdate(id++,text,entities));
    assert.equal(r.status,'IGNORED');
    assert.equal(r.plan,undefined);
   }
  }finally{await f.close();}
 });
 test('B6 '+engine+': other bot mention or quote cannot trigger the group assistant',async()=>{
  const f=await setup(engine);try{
   const other=await f.app(true).handle(mentionUpdate(220,'@AnotherBot '+QUESTION,[
    {type:'mention',offset:0,length:11}
   ]));
   assert.equal(other.status,'IGNORED');
   const text='سؤال مقتبس: @ManaratakBot '+QUESTION;
   const quote=await f.app(true).handle(mentionUpdate(221,text,[
    {type:'mention',offset:text.indexOf('@'),length:13}
   ]));
   assert.equal(quote.status,'IGNORED');
   const forwarded=await f.app(true).handle(mentionUpdate(222,'@ManaratakBot '+QUESTION,[
    {type:'mention',offset:0,length:13}
   ],{forward_date:1670000000}));
   assert.equal(forwarded.status,'DENIED');
   assert.equal(forwarded.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': malformed UTF-16 or overlapping mention entity is denied without a plan',async()=>{
  const f=await setup(engine);try{
   const text='@ManaratakBot '+QUESTION;
   const wrong=[
    [{type:'mention',offset:0,length:12}],
    [{type:'mention',offset:-1,length:13}],
    [{type:'mention',offset:0,length:13},{type:'mention',offset:0,length:13}],
    [{type:'mention',offset:0,length:13,actorId:'100'}],
    [{type:'mention',offset:0,length:13},{type:'mention',offset:2,length:8}]
   ];
   for(let i=0;i<wrong.length;i++){
    const r=await f.app(true).handle(mentionUpdate(230+i,text,wrong[i]));
    assert.equal(r.status,'DENIED');
    assert.equal(r.plan,undefined);
   }
  }finally{await f.close();}
 });
 test('B6 '+engine+': no B6 adapter can only answer an explicit mention using reviewed B3 FAQ',async()=>{
  const f=await setup(engine);try{
   const text='@ManaratakBot '+QUESTION;
   const result=await f.app(false).handle(mentionUpdate(250,text,[
    {type:'mention',offset:0,length:13}
   ]));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/جواب المجموعة فقط/);
   assert.doesNotMatch(result.plan?.text??'',/شروط معتمدة/);
  }finally{await f.close();}
 });
 test('B6 '+engine+': disabling group mention AI denies FAQ-backed mention; private FAQ stays independent',async()=>{
  const f=await setup(engine);try{
   await f.policy.configureGroupAI(OWNER,GROUP,'OFF');
   const text='@ManaratakBot '+QUESTION;
   const r=await f.app(true).handle(mentionUpdate(260,text,[
    {type:'mention',offset:0,length:13}
   ]));
   assert.equal(r.status,'DENIED');
   assert.equal(r.plan,undefined);
   assert.equal((await f.app(true).handle(msg(261,STUDENT,'/faq '+QUESTION))).status,'APPLIED');
  }finally{await f.close();}
 });
 test('B6 '+engine+': scope revocation during mention source lookup prevents sending stale text',async()=>{
  const f=await setup(engine);try{
   let enter!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>enter=r);
   const waiting=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async q=>{
    const answer=await f.knowledge.lookup(q);enter();await waiting;return answer;
   }};
   const text='@ManaratakBot '+QUESTION;
   const pending=f.app(true,source).handle(mentionUpdate(270,text,[
    {type:'mention',offset:0,length:13}
   ]));
   await started;
   await f.policy.revokeChat(OWNER,GROUP);release();
   const r=await pending;
   assert.equal(r.status,'DENIED');
   assert.equal(r.plan,undefined);
  }finally{await f.close();}
 });
}


const ownerReply=(updateId:number,actor:number,reply:unknown,asCommand=false)=> {
 const text=asCommand?'/ask@ManaratakBot أجب عن هذا السؤال':'@ManaratakBot أجب عن هذا السؤال';
 const base=msg(updateId,actor,text,true);
 return {...base,message:{...base.message,
  ...(asCommand?{}:{entities:[{type:'mention',offset:0,length:13}]}),
  ...(reply===undefined?{}:{reply_to_message:reply})}};
};
const studentQuestion=(id:number,text=QUESTION)=>({
 message_id:id,from:{id:STUDENT,is_bot:false},
 chat:{id:Number(GROUP),type:'supergroup'},text
});

for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': owner reply-to invocation answers exactly the targeted reviewed student question',async()=>{
  const f=await setup(engine);try{
   const r=await f.app(true).handle(ownerReply(400,Number(OWNER),studentQuestion(399)));
   assert.equal(r.status,'APPLIED');
   assert.match(r.plan?.text??'',/جواب المجموعة فقط/);
   assert.doesNotMatch(r.plan?.text??'',/شروط معتمدة|أجب عن هذا السؤال/);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
 test('B6 '+engine+': owner slash command reply uses only quoted question in absence of a generating adapter',async()=>{
  const f=await setup(engine);try{
   const r=await f.app(false).handle(ownerReply(410,Number(OWNER),studentQuestion(409),true));
   assert.equal(r.status,'APPLIED');
   assert.match(r.plan?.text??'',/جواب المجموعة فقط/);
  }finally{await f.close();}
 });
 test('B6 '+engine+': missing referenced Telegram message prompts owner to reattach instead of guessing',async()=>{
  const f=await setup(engine);try{
   const r=await f.app(true).handle(ownerReply(420,Number(OWNER),undefined));
   assert.equal(r.status,'APPLIED');
   assert.match(r.plan?.text??'',/بالرد|رد|أعد/);
   assert.doesNotMatch(r.plan?.text??'',/جواب المجموعة فقط|شروط معتمدة/);
  }finally{await f.close();}
 });
 test('B6 '+engine+': student cannot invoke privileged reply-to question even with an actual mention',async()=>{
  const f=await setup(engine);try{
   const r=await f.app(true).handle(ownerReply(430,STUDENT,studentQuestion(429)));
   assert.equal(r.status,'DENIED');
   assert.equal(r.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': forged or forwarded replied-to message never becomes a question',async()=>{
  const f=await setup(engine);try{
   const cases:unknown[]=[
    studentQuestion(439,'\n'+QUESTION),
    {...studentQuestion(439),forward_date:1720000000},
    {...studentQuestion(439),forward_origin:{type:'user'}},
    {...studentQuestion(439),sender_chat:{id:Number(GROUP)}},
    {...studentQuestion(439),via_bot:{id:999}},
    {...studentQuestion(439),from:{id:STUDENT,is_bot:true}},
    {...studentQuestion(439),chat:{id:-100998,type:'supergroup'}},
    {...studentQuestion(439),message_id:9999},
    {...studentQuestion(439),text:''},
    {...studentQuestion(439),text:QUESTION,caption:'untrusted'},
    {...studentQuestion(439),text:QUESTION,reply_to_message:studentQuestion(1)},
    {message_id:439,chat:{id:Number(GROUP),type:'supergroup'},text:QUESTION},
    null,[],{message_id:439,text:QUESTION}
   ];
   for(let i=0;i<cases.length;i++){
    const r=await f.app(true).handle(ownerReply(440+i,Number(OWNER),cases[i]));
    assert.equal(r.status,'DENIED',String(i));
    assert.equal(r.plan,undefined,String(i));
   }
  }finally{await f.close();}
 });
 test('B6 '+engine+': unrelated question in the owner reply does not scrape past chat or provide a fallback',async()=>{
  const f=await setup(engine);try{
   const r=await f.app(true).handle(ownerReply(480,Number(OWNER),
    studentQuestion(479,'سؤال غير معتمد داخل هذه المجموعة')));
   assert.equal(r.status,'DENIED');
   assert.equal(r.reason,'B6_NO_APPROVED_SOURCE');
   assert.equal(r.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': group AI OFF denies owner reply invocation without affecting private FAQ',async()=>{
  const f=await setup(engine);try{
   await f.policy.configureGroupAI(OWNER,GROUP,'OFF');
   const r=await f.app(true).handle(ownerReply(490,Number(OWNER),studentQuestion(489)));
   assert.equal(r.status,'DENIED');
   assert.equal(r.plan,undefined);
   const faq=await f.app(true).handle(msg(491,STUDENT,'/faq '+QUESTION));
   assert.equal(faq.status,'APPLIED');
  }finally{await f.close();}
 });
 test('B6 '+engine+': revocation during owner reply lookup cannot return stale reviewed answer',async()=>{
  const f=await setup(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r);
   const waiting=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async query=>{
    const out=await f.knowledge.lookup(query);entered();await waiting;return out;
   }};
   const pending=f.app(true,source).handle(ownerReply(500,Number(OWNER),studentQuestion(499)));
   await started;await f.policy.revokeChat(OWNER,GROUP);release();
   const r=await pending;
   assert.equal(r.status,'DENIED');
   assert.equal(r.plan,undefined);
  }finally{await f.close();}
 });
}


for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': new required subscription during FAQ wait denies stale no-rule permission',async()=>{
  const f=await setup(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r);
   const suspended=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async input=>{
    const value=await f.knowledge.lookup(input);entered();await suspended;return value;
   }};
   const pending=f.app(true,source,true).handle(msg(700,STUDENT,'/ask@ManaratakBot '+QUESTION,true));
   await started;
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.membership.set(CHANNEL,String(STUDENT),'MEMBER');
   release();
   const outcome=await pending;
   assert.equal(outcome.status,'DENIED');
   assert.equal(outcome.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': newly introduced rule denies stale group FAQ even without subscription adapter',async()=>{
  const f=await setup(engine);try{
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async q=>{
    const value=await f.knowledge.lookup(q);entered();await held;return value;
   }};
   const pending=f.app(true,source,false).handle(msg(701,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   await started;
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   release();
   const outcome=await pending;
   assert.equal(outcome.status,'DENIED');
   assert.equal(outcome.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': owner pausing required subscription during approved FAQ lookup voids old proof',async()=>{
  const f=await setup(engine);try{
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.membership.set(CHANNEL,String(STUDENT),'MEMBER');
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async q=>{
    const value=await f.knowledge.lookup(q);entered();await held;return value;
   }};
   const pending=f.app(true,source,true).handle(msg(702,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   await started;
   await f.subscription.configure(OWNER,GROUP,[],'ALL');
   release();
   const outcome=await pending;
   assert.equal(outcome.status,'DENIED');
   assert.equal(outcome.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': membership lost during FAQ lookup prevents a stale approved answer',async()=>{
  const f=await setup(engine);try{
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.membership.set(CHANNEL,String(STUDENT),'MEMBER');
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async q=>{
    const value=await f.knowledge.lookup(q);entered();await held;return value;
   }};
   const pending=f.app(true,source,true).handle(msg(703,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   await started;
   f.membership.set(CHANNEL,String(STUDENT),'NOT_MEMBER');
   release();
   const outcome=await pending;
   assert.equal(outcome.status,'DENIED');
   assert.equal(outcome.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': unchanged required membership allows a group reviewed FAQ response',async()=>{
  const f=await setup(engine);try{
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.membership.set(CHANNEL,String(STUDENT),'MEMBER');
   const outcome=await f.app(true,undefined,true).handle(msg(704,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   assert.equal(outcome.status,'APPLIED');
   assert.match(outcome.plan?.text??'',/جواب المجموعة فقط/);
  }finally{await f.close();}
 });
}


for(const engine of ['json','sqlite'] as const){
 test('B6 '+engine+': changed ALL to ANY subscription revision during approved FAQ wait invalidates evidence',async()=>{
  const f=await setup(engine);try{
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.membership.set(CHANNEL,String(STUDENT),'MEMBER');
   let entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
   const source:KnowledgeSourcePort={lookup:async q=>{
    const value=await f.knowledge.lookup(q);entered();await held;return value;
   }};
   const pending=f.app(true,source,true).handle(msg(705,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   await started;
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ANY');
   release();
   const outcome=await pending;
   assert.equal(outcome.status,'DENIED');
   assert.equal(outcome.plan,undefined);
  }finally{await f.close();}
 });
 test('B6 '+engine+': subscription changes during second membership verification are rejected',async()=>{
  const f=await setup(engine);try{
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.membership.set(CHANNEL,String(STUDENT),'MEMBER');
   const original=f.membership.getMember.bind(f.membership);
   let attempts=0,entered!:()=>void,release!:()=>void;
   const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
   f.membership.getMember=async(channel,user)=>{
    attempts++;
    if(attempts===2){entered();await held;}
    return original(channel,user);
   };
   const pending=f.app(true,undefined,true).handle(msg(706,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   await started;
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ANY');
   release();
   const outcome=await pending;
   assert.equal(outcome.status,'DENIED');
   assert.equal(outcome.plan,undefined);
   assert.equal(attempts,2);
  }finally{await f.close();}
 });
 test('B6 '+engine+': legacy B3 FAQ path retains active mandatory subscription enforcement',async()=>{
  const f=await setup(engine);try{
   await f.subscription.configure(OWNER,GROUP,[CHANNEL],'ALL');
   f.membership.set(CHANNEL,String(STUDENT),'MEMBER');
   const allowed=await f.app(false,undefined,true).handle(msg(707,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   assert.equal(allowed.status,'APPLIED');
   assert.match(allowed.plan?.text??'',/جواب المجموعة فقط/);
   f.membership.set(CHANNEL,String(STUDENT),'NOT_MEMBER');
   const denied=await f.app(false,undefined,true).handle(msg(708,STUDENT,
    '/ask@ManaratakBot '+QUESTION,true));
   assert.equal(denied.status,'DENIED');
   assert.equal(denied.plan,undefined);
  }finally{await f.close();}
 });
}
