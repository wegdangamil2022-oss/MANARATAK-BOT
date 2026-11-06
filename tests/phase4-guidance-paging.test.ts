import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4GuidanceService,parseGuidanceMemberCommand} from '../src/phase4-guidance.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {defaultCommunityConfig} from '../src/phase4-community-model.js';

const OWNER='100',MEMBER='200',CHAT='-1001234',SECOND='-1004567';
const NOW=1_800_000_000_000, faqId=(n:number)=>
 n.toString(16).padStart(8,'0')+'-2222-4333-8444-555555555555';
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-guide-pages-'));
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,CHAT,['navigation']);
 await policy.approveChat(OWNER,SECOND,['navigation']);
 const community=new Phase4CommunityService(store,policy,()=>NOW);
 const guide=new Phase4GuidanceService(store,policy,community);
 const education=new EducationService(store,policy,()=>NOW);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const app=()=>new TelegramUpdateApplication({store,policy,community,
  education,admin,faq,links,botId:'bot-main',botUsername:'ManaratakBot',clock:()=>NOW,
  membership:async()=>membership});
 await store.transaction(s=>{
  s.educationCategories.push({id:'category',scope:CHAT,parentId:null,title:'قسم القبول',
   order:1,enabled:true,groupVisible:true});
  s.educationResources.push({id:'resource',scope:CHAT,categoryId:'category',
   title:'مصدر المنشورات',university:'منارتك',cycle:'2026',degree:'بكالوريوس',seats:null,
   sourceImportId:'manual',sourceLocator:'https://example.com',
   reviewedBy:OWNER,status:'PUBLISHED'});
  for(let n=1;n<=13;n++)s.faqEntries.push({
   id:faqId(n),scope:CHAT,question:'سؤال التعليم <الآمن> '+n+' &'.repeat(45),
   aliases:[],answer:'الإجابة المعتمدة '+n,sourceResourceId:'resource',
   createdBy:OWNER,approvedBy:OWNER,status:'APPROVED',createdAt:NOW
  });
  s.phase4Community={configs:[{...defaultCommunityConfig(CHAT),version:1,
   rules:Array.from({length:12},(_,i)=>({
    id:(i+1).toString(16).padStart(12,'0'),trigger:'مصدر'+i,
    response:'&'.repeat(240),match:'WORD' as const,enabled:true,
    cooldownMs:60000,source:'NOTE' as const
   }))}],drafts:[],receipts:[]};
 });
 const msg=(n:number,actor:string,text:string)=>({update_id:n,message:{
  message_id:n,chat:{id:Number(actor),type:'private'},
  from:{id:Number(actor),is_bot:false},text
 }});
 return {dir,store,guide,app,msg,setMember:(v:typeof membership)=>{membership=v;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('GUIDE-012: strict student pagination grammar and no callback privilege',()=>{
 assert.deepEqual(parseGuidanceMemberCommand('/groupfaqs '+CHAT),
  {kind:'FAQ_INDEX',chatId:CHAT,page:1});
 assert.deepEqual(parseGuidanceMemberCommand('/groupfaqs '+CHAT+' 3'),
  {kind:'FAQ_INDEX',chatId:CHAT,page:3});
 assert.deepEqual(parseGuidanceMemberCommand('/groupnotes '+CHAT+' 2'),
  {kind:'NOTES_INDEX',chatId:CHAT,page:2});
 for(const bad of ['/groupfaqs '+CHAT+' 0','/groupfaqs '+CHAT+' -1',
  '/groupfaqs '+CHAT+' 01','/groupfaqs 100 2',
  '/groupnotes '+CHAT+' 1000','/groupfaqs '+CHAT+'\n','/groupnotes '+CHAT+' 4 extra'])
  assert.equal(parseGuidanceMemberCommand(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('GUIDE-013 '+engine+': group rules and full FAQ/note pagination stay below Telegram limit',async()=>{
  const f=await fixture(engine);
  try{
   const rules=await f.guide.member(CHAT,'RULES');
   assert.ok(rules);assert.ok(Buffer.byteLength(rules,'utf8')<=4096,
    'large ampersands in fixed notes cannot overflow a Telegram message');
   assert.match(rules,/\/groupfaqs/u);
   assert.match(rules,/\/groupnotes/u);
   const first=await f.guide.member(CHAT,'FAQ_INDEX',undefined,1);
   const second=await f.guide.member(CHAT,'FAQ_INDEX',undefined,2);
   assert.ok(first);assert.ok(second);
   assert.ok(Buffer.byteLength(first,'utf8')<=4096);
   assert.match(first,/سؤال التعليم/);
   assert.match(second,/صفحة 2/u);
   // Alphabetical sorting deliberately puts 10/11 before 2. Check complete
   // coverage across pages without depending on the locale's sort order.
   const allPages=await Promise.all([1,2,3,4].map(n=>
    f.guide.member(CHAT,'FAQ_INDEX',undefined,n)));
   for(let i=1;i<=13;i++)
    assert.ok(allPages.some(text=>text?.includes(faqId(i))),String(i));
   assert.doesNotMatch(second,new RegExp(faqId(1)));
   assert.equal(await f.guide.member(CHAT,'FAQ_INDEX',undefined,99),null);
   const note1=await f.guide.member(CHAT,'NOTES_INDEX',undefined,1);
   const note3=await f.guide.member(CHAT,'NOTES_INDEX',undefined,3);
   assert.ok(note1);assert.ok(note3);
   assert.ok(Buffer.byteLength(note3,'utf8')<=4096);
   assert.match(note3,/صفحة 3/u);
   assert.equal(await f.guide.member(CHAT,'NOTES_INDEX',undefined,4),null);
   assert.doesNotMatch((await f.guide.member(SECOND,'FAQ_INDEX',undefined,1))??'',
    /سؤال التعليم/u);
  }finally{await f.close();}
 });
 test('GUIDE-014 '+engine+': member checks and source revocation apply to every page',async()=>{
  const f=await fixture(engine);
  try{
   const good=await f.app().handle(f.msg(100,MEMBER,'/groupfaqs '+CHAT+' 2'));
   assert.equal(good.status,'APPLIED');assert.match(good.plan?.text??'',/صفحة 2/u);
   f.setMember('NOT_MEMBER');
   assert.equal((await f.app().handle(f.msg(101,MEMBER,'/groupnotes '+CHAT))).status,'DENIED');
   f.setMember('UNKNOWN');
   assert.equal((await f.app().handle(f.msg(102,MEMBER,'/groupfaqs '+CHAT))).status,'DENIED');
   f.setMember('VERIFIED');
   await f.store.transaction(s=>{s.educationResources[0]!.status='ARCHIVED';});
   const after=await f.guide.member(CHAT,'FAQ_INDEX',undefined,1);
   assert.ok(after);assert.doesNotMatch(after,/سؤال التعليم/u);
   assert.equal(await f.guide.member(CHAT,'FAQ',faqId(1)),null);
  }finally{await f.close();}
 });
}
