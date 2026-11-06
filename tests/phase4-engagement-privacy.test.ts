import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4EngagementReportsService} from '../src/phase4-engagement-reports.js';
import {engagementOwnerScreen} from '../src/phase4-engagement-owner.js';
import {Phase4ReactionsService} from '../src/phase4-reactions.js';

const OWNER='100',GROUP='-1001234',OTHER='-1005678',NOW=1_700_000_000_000;
for(const engine of ['json','sqlite'] as const){
 test('REPORT-006 '+engine+': protect small reaction audiences 1..4 while reporting >=5 without usernames',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-report-redact-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const reactions=new Phase4ReactionsService(store,policy,()=>NOW,
    async()=> 'VERIFIED');
   const reports=new Phase4EngagementReportsService(store,policy,()=>NOW);
   const target=await reactions.draft(OWNER,GROUP,{
    kind:'BOT_POST',messageId:31,
    description:'تجربة المذاكرة الجماعية قبل الاختبارات',durationMinutes:60});
   await reactions.open(OWNER,target.id,1);
   for(let i=0;i<4;i++)
    assert.equal((await reactions.like(String(900+i),target.id)).status,'LIKED');
   const small=await engagementOwnerScreen(reports,OWNER,'/engagement '+GROUP+' DAY');
   assert.ok(small);
   assert.match(small.text,/إعجابات المنشورات النشطة: <b>أقل من 5<\/b>/);
   assert.doesNotMatch(small.text,/إعجابات المنشورات النشطة: <b>4<\/b>/);
   assert.doesNotMatch(small.text,/memberId|900|901|902|903|مُعرّف/);
   assert.equal((await reports.report(OWNER,GROUP,'DAY'))?.metrics.find(x=>x.key==='postLikesActive')?.count,4);
   assert.equal((await reactions.like('904',target.id)).status,'LIKED');
   const visible=await engagementOwnerScreen(reports,OWNER,'er:1:g:'+GROUP+':DAY');
   assert.match(visible?.text??'',/إعجابات المنشورات النشطة: <b>5<\/b>/);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('REPORT-007 '+engine+': expired identity evidence disappears from reports even if window still includes old time',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-report-expire-'));try{
   let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const reactions=new Phase4ReactionsService(store,policy,()=>now,
    async()=> 'VERIFIED');
   const reports=new Phase4EngagementReportsService(store,policy,()=>now);
   const target=await reactions.draft(OWNER,GROUP,{
    kind:'BOT_POST',messageId:31,
    description:'المهارات الدراسية وكيفية تنظيم الوقت',durationMinutes:60});
   await reactions.open(OWNER,target.id,1);
   await reactions.like('900',target.id);
   assert.equal((await reports.report(OWNER,GROUP,'MONTH'))?.metrics.find(x=>x.key==='postLikesActive')?.count,1);
   await reactions.close(OWNER,target.id,2);
   now+=86_400_001;
   await reactions.expire();
   const report=await reports.report(OWNER,GROUP,'MONTH');
   assert.equal(report?.metrics.find(x=>x.key==='postLikesActive')?.count,0);
   assert.match(report!.notes.join(' '),/الخصوصية|الحد الأقصى للتخزين|محفوظة/);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test('REPORT-008 '+engine+': group withdrawal revokes reports without revealing historical local counts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'p4-report-epoch-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>NOW);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   await policy.approveChat(OWNER,OTHER,['navigation']);
   const reports=new Phase4EngagementReportsService(store,policy,()=>NOW);
   assert.equal((await reports.groups(OWNER)).length,2);
   await policy.revokeChat(OWNER,GROUP);
   assert.deepEqual((await reports.groups(OWNER)).map(x=>x.chatId),[OTHER]);
   assert.equal(await reports.report(OWNER,GROUP,'DAY'),null);
   assert.equal(await engagementOwnerScreen(reports,OWNER,'er:1:g:'+GROUP+':DAY'),null);
   assert.ok(await reports.report(OWNER,OTHER,'DAY'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
