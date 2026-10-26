import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { ApprovedAnswerService, ResourceLinkService } from '../src/education-interactions.js';
import { EducationAdminFacade } from '../src/education-admin.js';

const OWNER='100', UPLOADER='200', PUBLISHER='300', STUDENT='400', OUTSIDER='500', GROUP='-10001', OTHER='-20002';
async function setup() {
  const dir=await mkdtemp(join(tmpdir(), 'manaratak-b3-interactions-'));
  const file=join(dir, 'state.json'); const clock=()=>10_000;
  const store=new BotStore(file); const policy=new Policy(store, OWNER, clock);
  const education=new EducationService(store, policy, clock);
  const faq=new ApprovedAnswerService(store,policy,clock);
  const links=new ResourceLinkService(store,policy,clock);
  const admin=new EducationAdminFacade(store,policy,education);
  await policy.approveChat(OWNER,GROUP,['navigation','assistant']);
  await policy.approveChat(OWNER,OTHER,['navigation','assistant']);
  await policy.configureGroupAI(OWNER,GROUP,'ALL_MENTION');
  await policy.grant(OWNER,UPLOADER,'content.upload',GROUP,20_000);
  await policy.grant(OWNER,PUBLISHER,'content.publish',GROUP,20_000);
  await education.createCategory(OWNER,{id:'scholarships',scope:GROUP,title:'المنح',order:1});
  await education.createCategory(OWNER,{id:'private-resources',scope:'private',title:'دليل خاص',order:1});
  const csv='title,university,cycle\nScholarship A,University One,2026\n';
  const run=await education.submitText(UPLOADER,GROUP,'ADMIN_WEB','csv','s.csv',csv);
  await education.approveCandidate(PUBLISHER,run.id,0,'scholarships');
  const resource=await education.publishCandidate(PUBLISHER,run.id,0,'scholarships');
  return {dir,file,store,policy,education,faq,links,admin,resource,run,clock,close:()=>rm(dir,{recursive:true,force:true})};
}

test('FAQ draft is not returned until reviewed, and published source is mandatory',async()=>{
  const c=await setup(); try {
    const draft=await c.faq.submit(UPLOADER,GROUP,{question:'ما منح 2026؟',aliases:[' منح 2026 '],answer:'راجع التفاصيل المعتمدة',sourceResourceId:c.resource.id});
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'ما منح 2026؟',true)).status,'NO_MATCH');
    await assert.rejects(c.faq.approve(UPLOADER,draft.id),/PUBLISH_DENIED/);
    await c.faq.approve(PUBLISHER,draft.id);
    const answer=await c.faq.answerGroup(STUDENT,GROUP,'ما منح 2026؟',true);
    assert.equal(answer.status,'ANSWER'); if (answer.status==='ANSWER') assert.equal(answer.answer,'راجع التفاصيل المعتمدة');
  } finally {await c.close();}
});

test('FAQ mention respects OFF, OWNER_MENTION, other scope and ordinary messages',async()=>{
  const c=await setup(); try {
    const q=await c.faq.submit(UPLOADER,GROUP,{question:'When?',answer:'2026',sourceResourceId:c.resource.id});
    await c.faq.approve(PUBLISHER,q.id);
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'When?',false)).status,'DISABLED');
    await c.policy.configureGroupAI(OWNER,GROUP,'OWNER_MENTION');
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'When?',true)).status,'DISABLED');
    assert.equal((await c.faq.answerGroup(OWNER,GROUP,'When?',true)).status,'ANSWER');
    assert.equal((await c.faq.answerGroup(STUDENT,OTHER,'When?',true)).status,'DISABLED');
    await c.policy.configureGroupAI(OWNER,GROUP,'OFF');
    assert.equal((await c.faq.answerGroup(OWNER,GROUP,'When?',true)).status,'DISABLED');
  } finally {await c.close();}
});

test('FAQ prevents same question collisions and returns AMBIGUOUS without choosing an answer',async()=>{
  const c=await setup(); try {
    const a=await c.faq.submit(UPLOADER,GROUP,{question:'Study?',answer:'First',sourceResourceId:c.resource.id});
    const b=await c.faq.submit(UPLOADER,GROUP,{question:'STUDY!',answer:'Second',sourceResourceId:c.resource.id});
    await c.faq.approve(PUBLISHER,a.id);
    await c.faq.approve(PUBLISHER,b.id);
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'study',true)).status,'AMBIGUOUS');
  } finally {await c.close();}
});

test('FAQ rejects invalid input and draft source or cross-scope resource',async()=>{
  const c=await setup(); try {
    await assert.rejects(c.faq.submit(UPLOADER,GROUP,{question:'',answer:'Answer',sourceResourceId:c.resource.id}),/INVALID_FAQ/);
    await assert.rejects(c.faq.submit(UPLOADER,GROUP,{question:'Help?',answer:'A',aliases:Array(30).fill('x'),sourceResourceId:c.resource.id}),/INVALID_FAQ/);
    await assert.rejects(c.faq.submit(UPLOADER,OTHER,{question:'Help?',answer:'A',sourceResourceId:c.resource.id}),/UPLOAD_DENIED/);
    await assert.rejects(c.faq.submit(UPLOADER,GROUP,{question:'Help?',answer:'A',sourceResourceId:'nonexistent'}),/SOURCE_NOT_PUBLISHED/);
  } finally {await c.close();}
});

test('FAQ automatically ceases after archived source, category disable or chat revocation',async()=>{
  const c=await setup(); try {
    const q=await c.faq.submit(UPLOADER,GROUP,{question:'Where?',answer:'See catalog',sourceResourceId:c.resource.id}); await c.faq.approve(PUBLISHER,q.id);
    await c.education.setCategoryEnabled(OWNER,'scholarships',false);
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'Where?',true)).status,'NO_MATCH');
    await c.education.setCategoryEnabled(OWNER,'scholarships',true);
    await c.policy.revokeChat(OWNER,GROUP);
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'Where?',true)).status,'DISABLED');
    await c.policy.approveChat(OWNER,GROUP,['navigation','assistant']);
    // Explicitly re-delegate after reapproval; old role may not revive.
    await c.policy.grant(OWNER,PUBLISHER,'content.publish',GROUP,20_000);
    await c.education.archiveResource(PUBLISHER,c.resource.id);
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'Where?',true)).status,'NO_MATCH');
  } finally {await c.close();}
});

test('FAQ private mode OFF cannot be bypassed by FAQ; browsing independent',async()=>{
  const c=await setup(); try {
    assert.equal((await c.faq.answerPrivate(STUDENT,'anything',true)).status,'DISABLED');
    assert.equal((await c.education.listCategories(STUDENT,'private')).length,1);
    await c.policy.configurePrivateAI(OWNER,'ALL_OPT_IN');
    assert.equal((await c.faq.answerPrivate(STUDENT,'anything',false)).status,'DISABLED');
  } finally {await c.close();}
});

test('opaque resource link resolves with verified membership only; stale, outsider, revoked deny',async()=>{
  const c=await setup(); try {
    const ref=await c.links.issue(PUBLISHER,c.resource.id,18_000);
    assert.match(ref,/^r_[a-zA-Z0-9_-]{24}$/);
    assert.ok(Buffer.byteLength(ref)<=64);
    assert.equal((await c.links.resolve(ref,STUDENT,async()=> 'UNKNOWN')).status,'DENIED');
    assert.equal((await c.links.resolve(ref,STUDENT,async()=> 'NOT_MEMBER')).status,'DENIED');
    const ok=await c.links.resolve(ref,STUDENT,async(chat,actor)=>chat===GROUP&&actor===STUDENT?'VERIFIED':'UNKNOWN');
    assert.equal(ok.status,'FOUND'); if(ok.status==='FOUND') { assert.equal('sourceImportId' in ok.resource,false); assert.equal('reviewedBy' in ok.resource,false); }
    await c.policy.revokeChat(OWNER,GROUP);
    assert.equal((await c.links.resolve(ref,STUDENT,async()=> 'VERIFIED')).status,'DENIED');
  } finally {await c.close();}
});

test('short resource links must never trust membership claim or cross scope',async()=>{
  const c=await setup(); try {
    await assert.rejects(c.links.issue(UPLOADER,c.resource.id,18_000),/PUBLISH_DENIED/);
    const ref=await c.links.issue(PUBLISHER,c.resource.id,18_000,STUDENT);
    assert.equal((await c.links.resolve(ref,OUTSIDER,async()=> 'VERIFIED')).status,'DENIED');
    assert.equal((await c.links.resolve('r_untrusted',STUDENT,async()=> 'VERIFIED')).status,'DENIED');
    await c.links.revoke(PUBLISHER,ref);
    assert.equal((await c.links.resolve(ref,STUDENT,async()=> 'VERIFIED')).status,'DENIED');
  } finally {await c.close();}
});

test('resource links expire and survive restart; no network effects',async()=>{
  const c=await setup(); try {
    const ref=await c.links.issue(PUBLISHER,c.resource.id,12_000);
    const newStore=new BotStore(c.file),newPolicy=new Policy(newStore,OWNER,()=>11_000);
    const afterRestart=new ResourceLinkService(newStore,newPolicy,()=>11_000);
    assert.equal((await afterRestart.resolve(ref,STUDENT,async()=> 'VERIFIED')).status,'FOUND');
    const expired=new ResourceLinkService(newStore,newPolicy,()=>13_000);
    assert.equal((await expired.resolve(ref,STUDENT,async()=> 'VERIFIED')).status,'DENIED');
  } finally {await c.close();}
});

test('admin facade rejects unauthenticated, fake private chat and revocation, no bypass',async()=>{
  const c=await setup(); try {
    await assert.rejects(c.admin.panel({origin:'TELEGRAM_PRIVATE',actorId:OWNER,chatId:'900',verified:true},GROUP),/UNTRUSTED_ADMIN_CONTEXT/);
    await assert.rejects(c.admin.panel({origin:'ADMIN_WEB',actorId:OWNER,chatId:OWNER,verified:false},GROUP),/UNTRUSTED_ADMIN_CONTEXT/);
    const student=await c.admin.panel({origin:'TELEGRAM_PRIVATE',actorId:STUDENT,chatId:STUDENT,verified:true},GROUP);
    assert.equal(student.canPublish,false);assert.equal(student.canUpload,false);
    const owner=await c.admin.panel({origin:'TELEGRAM_PRIVATE',actorId:OWNER,chatId:OWNER,verified:true},GROUP);
    assert.equal(owner.canPublish,true);assert.equal(owner.canUpload,true);
    await assert.rejects(c.admin.upload({origin:'TELEGRAM_PRIVATE',actorId:STUDENT,chatId:STUDENT,verified:true},GROUP,'csv','x.csv','title,university\nA,B'),/UPLOAD_DENIED/);
    await c.policy.revokeGrant(OWNER,UPLOADER,'content.upload',GROUP);
    await assert.rejects(c.admin.upload({origin:'ADMIN_WEB',actorId:UPLOADER,chatId:UPLOADER,verified:true},GROUP,'csv','x.csv','title,university\nA,B'),/UPLOAD_DENIED/);
  } finally {await c.close();}
});

test('admin facades distinguish upload and publish grants for preview and execution',async()=>{
  const c=await setup();try {
    const uploader={origin:'ADMIN_WEB' as const,actorId:UPLOADER,chatId:UPLOADER,verified:true};
    const publisher={origin:'ADMIN_WEB' as const,actorId:PUBLISHER,chatId:PUBLISHER,verified:true};
    const run=await c.admin.upload(uploader,GROUP,'csv','admin.csv','title,university\nAnother,Local');
    await assert.rejects(c.admin.approve(publisher,run.id,0,'private-resources'),/CATEGORY_SCOPE_MISMATCH/);
    await assert.rejects(c.admin.approve(uploader,run.id,0,'scholarships'),/PUBLISH_DENIED/);
    await c.admin.approve(publisher,run.id,0,'scholarships');
    const resource=await c.admin.publish(publisher,run.id,0,'scholarships');
    assert.equal(resource.title,'Another');
    const visible=await c.education.listResources(STUDENT,GROUP,'scholarships');
    assert.equal(visible.length,2);assert.equal('reviewedBy' in visible[0]!,false);assert.equal('sourceImportId' in visible[0]!,false);
  } finally{await c.close();}
});

test('v3 states upgrade additively to v4 without losing approved resources or grants',async()=>{
  const c=await setup();try {
    const old=await c.store.snapshot() as unknown as Record<string,unknown>;
    old.schemaVersion=3;delete old.faqEntries;delete old.resourceLinks;
    await writeFile(c.file,JSON.stringify(old));
    const migrated=await new BotStore(c.file).snapshot();
    assert.equal(migrated.schemaVersion,8);
    assert.equal(migrated.educationResources.length,1);assert.equal(migrated.grants.length,2);
    assert.deepEqual(migrated.faqEntries,[]);assert.deepEqual(migrated.resourceLinks,[]);
  } finally{await c.close();}
});

test('FAQ archive and reopened question does not expose old approved answer',async()=>{
  const c=await setup();try {
    const q=await c.faq.submit(UPLOADER,GROUP,{question:'Next?',answer:'Approved answer',sourceResourceId:c.resource.id});
    await c.faq.approve(PUBLISHER,q.id);
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'Next?',true)).status,'ANSWER');
    await c.faq.archive(PUBLISHER,q.id);
    assert.equal((await c.faq.answerGroup(STUDENT,GROUP,'Next?',true)).status,'NO_MATCH');
    await assert.rejects(c.faq.approve(PUBLISHER,q.id),/FAQ_ARCHIVED/);
  }finally{await c.close();}
});

test('resource link fails if chat permission is revoked while membership verification is pending',async()=>{
  const c=await setup();try {
    const ref=await c.links.issue(PUBLISHER,c.resource.id,18_000);
    const result=await c.links.resolve(ref,STUDENT,async()=>{
      await c.policy.revokeChat(OWNER,GROUP);
      return 'VERIFIED';
    });
    assert.equal(result.status,'DENIED');
  }finally{await c.close();}
});

test('resource link denies archived source, disabled category and bot navigation switched off',async()=>{
  const c=await setup();try {
    const ref=await c.links.issue(PUBLISHER,c.resource.id,18_000);
    await c.education.setCategoryEnabled(OWNER,'scholarships',false);
    assert.equal((await c.links.resolve(ref,STUDENT,async()=> 'VERIFIED')).status,'DENIED');
    await c.education.setCategoryEnabled(OWNER,'scholarships',true);
    await c.education.archiveResource(PUBLISHER,c.resource.id);
    assert.equal((await c.links.resolve(ref,STUDENT,async()=> 'VERIFIED')).status,'DENIED');
  }finally{await c.close();}
});

test('owner admin panel must reflect private upload switch instead of promising unavailable access',async()=>{
  const c=await setup();try {
    const owner={origin:'TELEGRAM_PRIVATE' as const,actorId:OWNER,chatId:OWNER,verified:true};
    const features=await c.admin.panel(owner,'private');
    assert.equal(features.canUpload,false);
    await assert.rejects(c.admin.upload(owner,'private','csv','x.csv','title,university\nA,B'),/UPLOAD_DENIED/);
    assert.equal(features.canPublish,true);
  }finally{await c.close();}
});
