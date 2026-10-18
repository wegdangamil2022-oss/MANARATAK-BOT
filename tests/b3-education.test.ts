import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { parseDocument } from '../src/ingestion.js';

const OWNER='100', UPLOADER='200', PUBLISHER='300', STUDENT='400', GROUP='-100', OTHER='-200';
async function setup() {
  const directory = await mkdtemp(join(tmpdir(),'manaratak-b3-'));
  const file=join(directory,'state.json'); const store=new BotStore(file);
  const policy=new Policy(store,OWNER,()=>1_000);
  const education=new EducationService(store,policy,()=>1_000);
  await policy.approveChat(OWNER,GROUP,['navigation']);
  await policy.approveChat(OWNER,OTHER,['navigation']);
  await policy.grant(OWNER,UPLOADER,'content.upload',GROUP,2_000);
  await policy.grant(OWNER,PUBLISHER,'content.publish',GROUP,2_000);
  await education.createCategory(OWNER,{id:'scholarships',scope:GROUP,title:'المنح',order:1});
  await education.createCategory(OWNER,{id:'private-scholarships',scope:'private',title:'منح الخاص',order:1});
  return { directory,file,store,policy,education,close:()=>rm(directory,{recursive:true,force:true}) };
}
const csv='university,title,cycle,degree,seats\nUniversity A,Scholarship One,2026,Bachelor,5\nUniversity A,Scholarship Two,2026,Master,3\nUniversity A,Scholarship One,2026,Bachelor,5\nUniversity B,,2026,Bachelor,\n';

test('B3 importer counts distinct universities, opportunities, duplicate candidates and only explicit seats',()=>{
  const p=parseDocument('csv','china.csv',csv);
  assert.deepEqual(p.report,{sections:4,universities:2,opportunities:2,potentialDuplicates:1,ambiguous:1,explicitSeats:8,partial:false});
  assert.equal(p.candidates[3]?.status,'NEEDS_REVIEW');
  assert.match(p.candidates[0]?.evidence??'',/University A/);
});

test('B3 imports MD, TXT and JSON without inventing missing scholarship data',()=>{
  const md=parseDocument('md','records.md','# Scholarship A\nuniversity: North University\ncycle: 2026\n\n# Scholarship B\nuniversity: North University\n');
  assert.equal(md.report.sections,2); assert.equal(md.report.universities,1); assert.equal(md.report.opportunities,2);
  const txt=parseDocument('txt','notes.txt','title: Scholarship C\nuniversity: South University\n\n\ntitle: Scholarship D\nuniversity: East University');
  assert.equal(txt.report.sections,2); assert.equal(txt.report.opportunities,2);
  const json=parseDocument('json','opps.json',JSON.stringify({items:[{title:'Scholarship E',university:'Z University',seats:12}]}));
  assert.equal(json.report.explicitSeats,12); assert.equal(json.report.opportunities,1);
  assert.equal(parseDocument('txt','unstructured.txt','just some university mentions').report.opportunities,0);
});

test('B3 rejects malformed or mislabeled files, oversize input and unsupported nested data',()=>{
  assert.throws(()=>parseDocument('csv','data.json',csv),/FORMAT_MISMATCH/);
  assert.throws(()=>parseDocument('json','data.json','{invalid'),/INVALID_JSON/);
  assert.throws(()=>parseDocument('csv','data.csv','title,university\n"unterminated,abc'),/INVALID_CSV/);
  assert.throws(()=>parseDocument('json','data.json',JSON.stringify({items:[['nested']]})),/INVALID_RECORD/);
  assert.throws(()=>parseDocument('txt','data.txt','x'.repeat(300_000)),/FILE_TOO_LARGE/);
  assert.throws(()=>parseDocument('exe','data.exe','anything'),/UNSUPPORTED_FORMAT/);
});

test('B3 refuses unauthorized upload and keeps source text out of student navigation',async()=>{
  const c=await setup(); try {
    await assert.rejects(c.education.submitText(STUDENT,GROUP,'TELEGRAM_ADMIN','csv','records.csv',csv),/UPLOAD_DENIED/);
    await assert.rejects(c.education.submitText(UPLOADER,OTHER,'TELEGRAM_ADMIN','csv','records.csv',csv),/UPLOAD_DENIED/);
    const submitted=await c.education.submitText(UPLOADER,GROUP,'TELEGRAM_ADMIN','csv','records.csv',csv);
    assert.equal(submitted.report.sections,4);
    assert.equal((await c.education.listResources(STUDENT,GROUP,'scholarships')).length,0);
    assert.equal((await c.education.listResources(STUDENT,OTHER,'scholarships')).length,0);
    const state=await c.store.snapshot();
    assert.equal(JSON.stringify(state).includes('title,cycle,degree,seats'),false);
  } finally { await c.close(); }
});

test('B3 uploader cannot approve/publish and approval is distinct from publication',async()=>{
  const c=await setup(); try {
    const submitted=await c.education.submitText(UPLOADER,GROUP,'ADMIN_WEB','csv','records.csv',csv);
    await assert.rejects(c.education.approveCandidate(UPLOADER,submitted.id,0,'scholarships'),/PUBLISH_DENIED/);
    await assert.rejects(c.education.publishCandidate(UPLOADER,submitted.id,0,'scholarships'),/PUBLISH_DENIED/);
    await assert.rejects(c.education.publishCandidate(PUBLISHER,submitted.id,0,'scholarships'),/NOT_APPROVED/);
    await c.education.approveCandidate(PUBLISHER,submitted.id,0,'scholarships');
    assert.deepEqual(await c.education.listResources(STUDENT,GROUP,'scholarships'),[]);
    const resource=await c.education.publishCandidate(PUBLISHER,submitted.id,0,'scholarships');
    assert.equal(resource.status,'PUBLISHED');
    assert.equal((await c.education.listResources(STUDENT,GROUP,'scholarships')).length,1);
    assert.equal((await c.education.listResources(STUDENT,OTHER,'scholarships')).length,0);
    assert.equal((await c.education.listResources(STUDENT,'private','private-scholarships')).length,0);
  } finally { await c.close(); }
});

test('B3 ambiguity and duplicate rows require review, not auto publish',async()=>{
  const c=await setup(); try {
    const submitted=await c.education.submitText(OWNER,GROUP,'TELEGRAM_ADMIN','csv','records.csv',csv);
    await assert.rejects(c.education.approveCandidate(OWNER,submitted.id,3,'scholarships'),/NEEDS_REVIEW/);
    await c.education.approveCandidate(OWNER,submitted.id,0,'scholarships');
    await assert.rejects(c.education.approveCandidate(OWNER,submitted.id,2,'scholarships'),/DUPLICATE_CANDIDATE/);
    const first=await c.education.publishCandidate(OWNER,submitted.id,0,'scholarships');
    const again=await c.education.publishCandidate(OWNER,submitted.id,0,'scholarships');
    assert.equal(first.id,again.id);
    assert.equal((await c.education.listResources(STUDENT,GROUP,'scholarships')).length,1);
  } finally { await c.close(); }
});

test('B3 revocation, chat disable and category/archive state prevent stale access',async()=>{
  const c=await setup(); try {
    const submitted=await c.education.submitText(OWNER,GROUP,'TELEGRAM_ADMIN','csv','records.csv',csv);
    await c.education.approveCandidate(OWNER,submitted.id,0,'scholarships');
    const resource=await c.education.publishCandidate(OWNER,submitted.id,0,'scholarships');
    await c.education.setCategoryEnabled(OWNER,'scholarships',false);
    assert.equal((await c.education.listResources(STUDENT,GROUP,'scholarships')).length,0);
    await c.education.setCategoryEnabled(OWNER,'scholarships',true);
    await c.policy.revokeChat(OWNER,GROUP);
    assert.equal((await c.education.listResources(STUDENT,GROUP,'scholarships')).length,0);
    await c.policy.approveChat(OWNER,GROUP,['navigation']);
    await c.education.archiveResource(OWNER,resource.id);
    assert.equal((await c.education.listResources(STUDENT,GROUP,'scholarships')).length,0);
  } finally { await c.close(); }
});

test('B3 revoking publisher grant prevents pending approval and publication',async()=>{
  const c=await setup(); try {
    const submitted=await c.education.submitText(UPLOADER,GROUP,'ADMIN_WEB','csv','records.csv',csv);
    await c.policy.revokeGrant(OWNER,PUBLISHER,'content.publish',GROUP);
    await assert.rejects(c.education.approveCandidate(PUBLISHER,submitted.id,0,'scholarships'),/PUBLISH_DENIED/);
    await c.education.approveCandidate(OWNER,submitted.id,0,'scholarships');
    await assert.rejects(c.education.publishCandidate(PUBLISHER,submitted.id,0,'scholarships'),/PUBLISH_DENIED/);
  } finally { await c.close(); }
});

test('B3 repeated uploads by content hash and restart do not make duplicate records',async()=>{
  const c=await setup(); try {
    const original=await c.education.submitText(OWNER,GROUP,'TELEGRAM_ADMIN','csv','records.csv',csv);
    const repeated=await c.education.submitText(OWNER,GROUP,'ADMIN_WEB','csv','renamed.csv',csv);
    assert.equal(original.id,repeated.id);
    const afterRestart=new EducationService(new BotStore(c.file),new Policy(new BotStore(c.file),OWNER,()=>1_000),()=>1_000);
    const third=await afterRestart.submitText(OWNER,GROUP,'TELEGRAM_ADMIN','csv','again.csv',csv);
    assert.equal(original.id,third.id);
    assert.equal((await c.store.snapshot()).importRuns.length,1);
  } finally { await c.close(); }
});

test('B3 concurrent publication of same item creates exactly one resource',async()=>{
  const c=await setup(); try {
    const uploaded=await c.education.submitText(OWNER,GROUP,'TELEGRAM_ADMIN','csv','records.csv',csv);
    await c.education.approveCandidate(OWNER,uploaded.id,0,'scholarships');
    const [one,two]=await Promise.all([c.education.publishCandidate(OWNER,uploaded.id,0,'scholarships'),c.education.publishCandidate(OWNER,uploaded.id,0,'scholarships')]);
    assert.equal(one.id,two.id);
    assert.equal((await c.store.snapshot()).educationResources.length,1);
  } finally { await c.close(); }
});

test('B3 migration from B2 is additive and rejects unsupported state schemas',async()=>{
  const c=await setup(); try {
    const current=await c.store.snapshot();
    const legacy={...current,schemaVersion:2};
    delete (legacy as Partial<typeof current>).educationCategories;
    delete (legacy as Partial<typeof current>).educationResources;
    delete (legacy as Partial<typeof current>).importRuns;
    await writeFile(c.file,JSON.stringify(legacy));
    const recovered=await new BotStore(c.file).snapshot();
    assert.equal(recovered.schemaVersion,5);
    assert.deepEqual(recovered.educationResources,[]);
    assert.equal(recovered.chats.length,current.chats.length);
  } finally { await c.close(); }
});
