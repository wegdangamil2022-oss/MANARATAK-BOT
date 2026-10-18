import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { EducationAdminFacade } from '../src/education-admin.js';
import { ApprovedAnswerService, ResourceLinkService } from '../src/education-interactions.js';
import { TelegramUpdateApplication, telegramWebhookListener, escapeTelegramHtml } from '../src/telegram-transport.js';

const OWNER='100', STAFF='200', STUDENT='300', GROUP='-100123', SECRET='only_for_simulation_0123456789abcdefgh', USERNAME='ManaratakBot';
const message=(id:number,from:number,chat:number,kind:'private'|'supergroup',text:string,more:Record<string,unknown>={})=>({update_id:id,message:{message_id:id,chat:{id:chat,type:kind},from:{id:from,is_bot:false},text,...more}});
async function setup() {
  const dir=await mkdtemp(join(tmpdir(),'manaratak-webhook-'));
  const store=new BotStore(join(dir,'state.json'));const policy=new Policy(store,OWNER);
  const education=new EducationService(store,policy);const admin=new EducationAdminFacade(store,policy,education);
  const faq=new ApprovedAnswerService(store,policy);const links=new ResourceLinkService(store,policy);
  await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
  await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
  await policy.grant(OWNER,STAFF,'content.upload',GROUP,Date.now()+90_000);
  await education.createCategory(OWNER,{id:'grants',scope:GROUP,title:'منح <منارتك> & الخبر',order:1});
  const app=new TelegramUpdateApplication({store,policy,education,admin,faq,links,botId:'bot-1',botUsername:USERNAME,membership:async()=> 'VERIFIED'});
  return {dir,store,policy,education,admin,faq,links,app,close:()=>rm(dir,{recursive:true,force:true})};
}

async function withHttp(app:TelegramUpdateApplication,work:(base:string)=>Promise<void>) {
  const server:Server=createServer(telegramWebhookListener(app,SECRET));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {const address=server.address();if(!address||typeof address==='string')throw Error('missing port');await work(`http://127.0.0.1:${address.port}`);}finally {server.close();await once(server,'close');}
}
async function post(base:string,body:unknown,headers:Record<string,string>={},path='/telegram/webhook') {
  return fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':SECRET,...headers},body:typeof body==='string'?body:JSON.stringify(body)});
}

test('transport rejects unauthenticated, missing, invalid and oversized requests before state mutation', async()=>{
 const c=await setup();try {await withHttp(c.app,async base=>{
   assert.equal((await post(base,message(1,100,100,'private','/admin '+GROUP),{'x-telegram-bot-api-secret-token':'WRONG'})).status,401);
   assert.equal((await post(base,message(2,100,100,'private','/admin '+GROUP),{'x-telegram-bot-api-secret-token':''})).status,401);
   assert.equal((await post(base,message(3,100,100,'private','/admin '+GROUP),{'content-type':'text/plain'})).status,415);
   assert.equal((await post(base,'{oops')).status,400);
   assert.equal((await post(base,'x'.repeat(70_000))).status,413);
   assert.equal((await post(base,message(4,100,100,'private','/admin '+GROUP),{},'/other')).status,404);
   assert.equal((await fetch(base+'/telegram/webhook')).status,405);
   assert.equal((await c.store.snapshot()).updates.length,0);
 });}finally{await c.close();}
});

test('valid private admin panel comes from verified sender, not arbitrary asserted actor IDs',async()=>{
 const c=await setup();try {await withHttp(c.app,async base=>{
   const good=await post(base,message(10,100,100,'private',`/admin ${GROUP}`));
   assert.equal(good.status,200);assert.deepEqual(await good.json(),{ok:true,status:'APPLIED'});
   const stored=(await c.store.snapshot()).updates;
   assert.equal(stored.length,1);assert.equal(stored[0]?.status,'DONE');
   const spoof=await c.app.handle(message(11,200,100,'private',`/admin ${GROUP}`));
   assert.equal(spoof.status,'DENIED');assert.equal(spoof.plan,undefined);
   const student=await c.app.handle(message(12,300,300,'private',`/admin ${GROUP}`));
   assert.equal(student.status,'APPLIED');assert.match(student.plan?.text??'',/غير متاح/);
 });}finally{await c.close();}
});

test('private admin CSV import is separate from approval and publisher authorization',async()=>{
 const c=await setup();try {
  const run=await c.app.handle(message(20,200,200,'private',`/import ${GROUP} csv info.csv\ntitle,university,cycle\nScholarship A,University A,2026`));
  assert.equal(run.status,'APPLIED');assert.match(run.plan?.text??'',/يتطلب المراجعة/);
  const state=await c.store.snapshot();assert.equal(state.importRuns.length,1);assert.equal(state.educationResources.length,0);
  const id=state.importRuns[0]!.id;
  const refused=await c.app.handle(message(21,200,200,'private',`/approve ${id} 0 grants`));
  assert.equal(refused.status,'DENIED');assert.equal((await c.store.snapshot()).educationResources.length,0);
  const approved=await c.app.handle(message(22,100,100,'private',`/approve ${id} 0 grants`));
  assert.equal(approved.status,'APPLIED');
  const published=await c.app.handle(message(23,100,100,'private',`/publish ${id} 0 grants`));
  assert.equal(published.status,'APPLIED');assert.equal((await c.store.snapshot()).educationResources.length,1);
  const shown=await c.app.handle(message(24,300,Number(GROUP),'supergroup','/resources grants'));
  assert.equal(shown.status,'APPLIED');assert.match(shown.plan?.text??'',/Scholarship A/);
  assert.equal((shown.plan?.text??'').includes(id),false);
 }finally{await c.close();}
});

test('webhook duplicate import is idempotent across restart, and no plans are externally delivered',async()=>{
 const c=await setup();try {
  const u=message(40,200,200,'private',`/import ${GROUP} csv a.csv\ntitle,university\nA,B`);
  assert.equal((await c.app.handle(u)).status,'APPLIED');
  assert.equal((await c.app.handle(u)).status,'DUPLICATE');
  const newer=new TelegramUpdateApplication({store:new BotStore(join(c.dir,'state.json')),policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:USERNAME,membership:async()=> 'VERIFIED'});
  assert.equal((await newer.handle(u)).status,'DUPLICATE');
  assert.equal((await c.store.snapshot()).importRuns.length,1);
  await withHttp(c.app,async base=>{
    const response=await post(base,message(41,100,100,'private',`/admin ${GROUP}`));
    assert.deepEqual(await response.json(),{ok:true,status:'APPLIED'});
  });
 }finally{await c.close();}
});

test('group FAQ only responds to explicit bot mention, blocks forwards, foreign mentions and inactive chats',async()=>{
 const c=await setup();try {
  const run=await c.education.submitText(OWNER,GROUP,'ADMIN_WEB','csv','x.csv','title,university\nA,B');
  await c.education.approveCandidate(OWNER,run.id,0,'grants');const resource=await c.education.publishCandidate(OWNER,run.id,0,'grants');
  const q=await c.faq.submit(OWNER,GROUP,{question:'Scholarships?',answer:'See <b>verified</b> & apply',sourceResourceId:resource.id});await c.faq.approve(OWNER,q.id);
  const base=50;
  assert.equal((await c.app.handle(message(base,300,Number(GROUP),'supergroup','/ask@ElseBot Scholarships?'))).plan,undefined);
  assert.equal((await c.app.handle(message(base+1,300,Number(GROUP),'supergroup','/ask@ManaratakBot Scholarships?',{forward_origin:{type:'user'}}))).plan,undefined);
  const answer=await c.app.handle(message(base+2,300,Number(GROUP),'supergroup','/ask@ManaratakBot Scholarships?'));
  assert.equal(answer.status,'APPLIED');assert.match(answer.plan?.text??'',/&lt;b&gt;verified&lt;\/b&gt; &amp; apply/);
  await c.policy.revokeChat(OWNER,GROUP);
  const denied=await c.app.handle(message(base+3,300,Number(GROUP),'supergroup','/ask@ManaratakBot Scholarships?'));
  assert.equal(denied.plan,undefined);
 }finally{await c.close();}
});

test('HTML output escapes untrusted titles and never leaks unpublished resource metadata',async()=>{
 const c=await setup();try {
  assert.equal(escapeTelegramHtml(`<script>"'&`),'&lt;script&gt;&quot;&#39;&amp;');
  const cats=await c.app.handle(message(60,300,Number(GROUP),'supergroup','/categories'));
  assert.match(cats.plan?.text??'',/منح &lt;منارتك&gt; &amp; الخبر/);
  assert.equal('sourceImportId' in (cats.plan??{}),false);
 }finally{await c.close();}
});

test('private short resource reference never bypasses checked membership',async()=>{
 const c=await setup();try {
  const run=await c.education.submitText(OWNER,GROUP,'ADMIN_WEB','csv','x.csv','title,university\nA,B');
  await c.education.approveCandidate(OWNER,run.id,0,'grants');const r=await c.education.publishCandidate(OWNER,run.id,0,'grants');
  const link=await c.links.issue(OWNER,r.id,Date.now()+50_000);
  const f=await c.app.handle(message(70,300,300,'private',`/resource ${link}`));assert.equal(f.status,'APPLIED');assert.match(f.plan?.text??'',/A/);
  await c.policy.revokeChat(OWNER,GROUP);
  const blocked=await c.app.handle(message(71,300,300,'private',`/resource ${link}`));assert.equal(blocked.status,'DENIED');
 }finally{await c.close();}
});

test('unsupported forged updates and wrong bot context have no effects',async()=>{
 const c=await setup();try {
  assert.equal((await c.app.handle({update_id:80,message:{chat:{id:300,type:'private'},from:{id:300},text:'/admin '+GROUP,sender_chat:{id:123}}})).status,'DENIED');
  assert.equal((await c.app.handle(message(81,100,100,'private','/import '+GROUP+' csv x.csv\na,b',{via_bot:{id:3}}))).status,'DENIED');
  assert.equal((await c.app.handle({update_id:82,channel_post:{chat:{id:-99,type:'channel'},text:'/admin'}})).status,'IGNORED');
  assert.equal((await c.app.handle({update_id:'83',message:{}})).status,'DENIED');
  assert.equal((await c.store.snapshot()).importRuns.length,0);
 }finally{await c.close();}
});

test('subscription-gated group catalog refuses service until trusted membership is verified',async()=>{
 const c=await setup();try {
  await c.store.transaction(s=>{s.subscriptionRequirements.push({chatId:GROUP,channelIds:['-999'],mode:'ALL',version:1});});
  const blocked=await c.app.handle(message(90,300,Number(GROUP),'supergroup','/categories'));
  assert.equal(blocked.status,'DENIED');assert.equal(blocked.reason,'SUBSCRIPTION_UNAVAILABLE');
  const {ModerationService,FakeModerationGateway}=await import('../src/moderation.js');
  const {SubscriptionGate,FakeMembershipGateway}=await import('../src/subscription.js');
  const member=new FakeMembershipGateway();
  const moderation=new ModerationService(c.store,c.policy,new FakeModerationGateway());
  const gate=new SubscriptionGate(c.store,c.policy,member,moderation);
  const app=new TelegramUpdateApplication({store:c.store,policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:USERNAME,membership:async()=> 'VERIFIED',subscription:gate});
  await c.policy.approveChat(OWNER,GROUP,['navigation','assistant','verification']);
  await c.policy.approveChat(OWNER,'-999',['verification']);
  member.set('-999',STUDENT,'NOT_MEMBER');
  assert.equal((await app.handle(message(91,300,Number(GROUP),'supergroup','/categories'))).reason,'SUBSCRIPTION_REQUIRED');
  member.set('-999',STUDENT,'UNKNOWN');
  assert.equal((await app.handle(message(92,300,Number(GROUP),'supergroup','/categories'))).reason,'SUBSCRIPTION_UNAVAILABLE');
  member.set('-999',STUDENT,'MEMBER');
  assert.equal((await app.handle(message(93,300,Number(GROUP),'supergroup','/categories'))).status,'APPLIED');
 }finally{await c.close();}
});

test('group commands are disabled when permissions change during asynchronous membership verification',async()=>{
 const c=await setup();try {
  const {ModerationService,FakeModerationGateway}=await import('../src/moderation.js');
  const {SubscriptionGate,FakeMembershipGateway}=await import('../src/subscription.js');
  await c.policy.approveChat(OWNER,GROUP,['navigation','assistant','verification']);
  await c.policy.approveChat(OWNER,'-999',['verification']);
  await c.store.transaction(s=>{s.subscriptionRequirements.push({chatId:GROUP,channelIds:['-999'],mode:'ALL',version:1});});
  const member=new FakeMembershipGateway();
  member.set('-999',STUDENT,'MEMBER');
  member.getMember=async()=>{await c.policy.revokeChat(OWNER,GROUP);return 'MEMBER';};
  const gate=new SubscriptionGate(c.store,c.policy,member,new ModerationService(c.store,c.policy,new FakeModerationGateway()));
  const app=new TelegramUpdateApplication({store:c.store,policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:USERNAME,membership:async()=> 'VERIFIED',subscription:gate});
  const result=await app.handle(message(94,300,Number(GROUP),'supergroup','/categories'));
  assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
 }finally{await c.close();}
});

test('subscription requirements gate explicit group FAQ just like education navigation',async()=>{
 const c=await setup();try {
  const run=await c.education.submitText(OWNER,GROUP,'ADMIN_WEB','csv','q.csv','title,university\nA,B');
  await c.education.approveCandidate(OWNER,run.id,0,'grants');const resource=await c.education.publishCandidate(OWNER,run.id,0,'grants');
  const faq=await c.faq.submit(OWNER,GROUP,{question:'Scholarships?',answer:'Official guidance',sourceResourceId:resource.id});await c.faq.approve(OWNER,faq.id);
  await c.store.transaction(s=>{s.subscriptionRequirements.push({chatId:GROUP,channelIds:['-999'],mode:'ALL',version:1});});
  // A member may have access to FAQ, but a missing subscription verifier must fail closed.
  const blocked=await c.app.handle(message(101,Number(STUDENT),Number(GROUP),'supergroup','/ask@ManaratakBot Scholarships?'));
  assert.equal(blocked.reason,'SUBSCRIPTION_UNAVAILABLE');assert.equal(blocked.plan,undefined);
  const {ModerationService,FakeModerationGateway}=await import('../src/moderation.js');
  const {SubscriptionGate,FakeMembershipGateway}=await import('../src/subscription.js');
  await c.policy.approveChat(OWNER,GROUP,['navigation','assistant','verification']);
  await c.policy.approveChat(OWNER,'-999',['verification']);
  const member=new FakeMembershipGateway();const gate=new SubscriptionGate(c.store,c.policy,member,new ModerationService(c.store,c.policy,new FakeModerationGateway()));
  const app=new TelegramUpdateApplication({store:c.store,policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:USERNAME,membership:async()=> 'VERIFIED',subscription:gate});
  member.set('-999',STUDENT,'NOT_MEMBER');
  const refused=await app.handle(message(102,Number(STUDENT),Number(GROUP),'supergroup','/ask@ManaratakBot Scholarships?'));
  assert.equal(refused.reason,'SUBSCRIPTION_REQUIRED');assert.equal(refused.plan,undefined);
  member.set('-999',STUDENT,'MEMBER');
  const allowed=await app.handle(message(103,Number(STUDENT),Number(GROUP),'supergroup','/ask@ManaratakBot Scholarships?'));
  assert.equal(allowed.status,'APPLIED');assert.match(allowed.plan?.text??'',/Official guidance/);
 }finally{await c.close();}
});

test('private commands cannot enumerate approved group resources without trusted group membership',async()=>{
 const c=await setup();try {
  const run=await c.education.submitText(OWNER,GROUP,'ADMIN_WEB','csv','q.csv','title,university\nHidden grant,University A');
  await c.education.approveCandidate(OWNER,run.id,0,'grants');await c.education.publishCandidate(OWNER,run.id,0,'grants');
  const untrusted=new TelegramUpdateApplication({store:c.store,policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:USERNAME,membership:async()=> 'UNKNOWN'});
  for(const command of [`/categories ${GROUP}`,`/resources ${GROUP} grants`]){
   const result=await untrusted.handle(message(110+command.length,Number(STUDENT),Number(STUDENT),'private',command));
   assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
  }
  const trusted=await c.app.handle(message(121,Number(STUDENT),Number(STUDENT),'private',`/resources ${GROUP} grants`));
  assert.equal(trusted.status,'APPLIED');assert.match(trusted.plan?.text??'',/Hidden grant/);
 }finally{await c.close();}
});

test('private group resource listing rechecks authorization after asynchronous membership verification',async()=>{
 const c=await setup();try {
  const gate=new TelegramUpdateApplication({store:c.store,policy:c.policy,education:c.education,admin:c.admin,faq:c.faq,links:c.links,botId:'bot-1',botUsername:USERNAME,membership:async()=>{
   await c.policy.revokeChat(OWNER,GROUP);
   return 'VERIFIED';
  }});
  const result=await gate.handle(message(125,Number(STUDENT),Number(STUDENT),'private',`/categories ${GROUP}`));
  assert.equal(result.status,'DENIED');assert.equal(result.plan,undefined);
 }finally{await c.close();}
});
