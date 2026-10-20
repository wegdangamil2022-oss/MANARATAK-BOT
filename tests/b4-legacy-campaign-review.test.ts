import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { PublicationService, FakePublicationGateway } from '../src/publishing.js';
import { HistoricalPublicationReviewService } from '../src/legacy-campaign-review.js';
import type { LegacyEvidence } from '../src/legacy-publication-migration.js';

const OWNER='100',EDITOR='201',SOURCE='-100',DEST='-200';
async function fixture() {
 const dir=await mkdtemp(join(tmpdir(),'b4-legacy-guard-'));const file=join(dir,'state.json');
 const store=new BotStore(file), clock=()=>1000, policy=new Policy(store,OWNER,clock);
 const education=new EducationService(store,policy,clock), gateway=new FakePublicationGateway();
 const publication=()=>new PublicationService(new BotStore(file),new Policy(new BotStore(file),OWNER,clock),gateway,clock);
 let verify=(e:LegacyEvidence)=>Promise.resolve(e.evidenceId.startsWith('verified-'));
 const review=()=>new HistoricalPublicationReviewService(new BotStore(file),new Policy(new BotStore(file),OWNER,clock), e=>verify(e),clock);
 await policy.approveChat(OWNER,SOURCE,['navigation']);await policy.approveChat(OWNER,DEST,['publishing']);
 await education.createCategory(OWNER,{id:'grants',scope:SOURCE,title:'المنح',order:1});
 const imp=await education.submitText(OWNER,SOURCE,'ADMIN_WEB','csv','records.csv',
   'title,university\\nGrant A,University A\\nGrant B,University B\\nGrant C,University C\\n'.replace(/\\n/g,'\n'));
 const resources=[];
 for(let i=0;i<3;i++){await education.approveCandidate(OWNER,imp.id,i,'grants');resources.push(await education.publishCandidate(OWNER,imp.id,i,'grants'));}
 return {dir,file,store,policy,education,publication,review,resources,gateway,
  setVerifier:(fn:(e:LegacyEvidence)=>Promise<boolean>)=>{verify=fn;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
const receipt=(resourceId:string,revision:string,messageId:string,evidenceId:string):LegacyEvidence=>({
 itemId:resourceId,revision,destination:DEST,messageId,evidenceId,source:'FORWARDED_POST'
});

test('B4 legacy integration: last forwarded post only verifies its item; earlier UNKNOWN records block new campaign reservation',async()=>{
 const f=await fixture();try {
   const ids=f.resources.map(x=>x.id);
   const draft=await f.publication().draft(OWNER,SOURCE,DEST,ids);
   const revision=draft.previews[2]!.revision;
   const evidence=receipt(ids[2]!,revision,'legacy-message-c','verified-c');
   const plan=await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:ids,evidence:[evidence],lastSeenOrdinal:3});
   assert.deepEqual(plan.records.map(x=>x.status),['UNVERIFIED','UNVERIFIED','PUBLISHED_VERIFIED']);
   assert.equal(plan.totals.PUBLISHED_VERIFIED,1);
   assert.equal(plan.totals.UNVERIFIED,2);
   const state=await (new BotStore(f.file)).snapshot();
   assert.equal(state.historicalPublications.length,3);
   assert.equal(state.historicalPublications[2]!.proof?.messageId,'legacy-message-c');
   assert.equal(state.deliveries.length,0);
   await assert.rejects(f.publication().approve(OWNER,draft.id),/HISTORICAL_REVIEW_BLOCKS_REPUBLICATION/);
   assert.equal((await f.store.snapshot()).deliveries.length,0);
   assert.equal(f.gateway.calls.length,0);
 } finally{await f.close();}
});

test('B4 legacy integration: separately reviewed skip never becomes a verified Telegram delivery',async()=>{
 const f=await fixture();try{
  const id=f.resources[0]!.id;
  const plan=await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[],
    manualSkips:[{itemId:id,actor:OWNER,reason:'تم تجاوز هذا الإعلان يدويًا'}]});
  assert.equal(plan.records[0]!.status,'MANUALLY_SKIPPED');
  const state=await f.store.snapshot();
  assert.equal(state.historicalPublications[0]!.status,'MANUALLY_SKIPPED');
  assert.equal(state.historicalPublications[0]!.proof,undefined);
  assert.equal(state.deliveries.length,0);
 }finally{await f.close()}
});

test('B4 legacy integration: revocation while awaiting external receipt verification aborts entire batch',async()=>{
 const f=await fixture();try{
  await f.policy.grant(OWNER,EDITOR,'content.publish',SOURCE,20_000);
  await f.policy.grant(OWNER,EDITOR,'content.publish',DEST,20_000);
  const id=f.resources[0]!.id;
  const draft=await f.publication().draft(EDITOR,SOURCE,DEST,[id]);
  f.setVerifier(async()=>{await f.policy.revokeGrant(OWNER,EDITOR,'content.publish',DEST);return true;});
  await assert.rejects(f.review().review(EDITOR,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],
    evidence:[receipt(id,draft.previews[0]!.revision,'message-1','verified-one')]}),/PUBLISH_DENIED/);
  assert.equal((await f.store.snapshot()).historicalPublications.length,0);
  assert.equal(f.gateway.calls.length,0);
 }finally{await f.close()}
});

test('B4 legacy integration: reused verified evidence and message IDs cannot certify two separate resources across batches',async()=>{
 const f=await fixture();try{
  const ids=f.resources.map(x=>x.id);
  const draft=await f.publication().draft(OWNER,SOURCE,DEST,ids);
  await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[ids[0]!],
    evidence:[receipt(ids[0]!,draft.previews[0]!.revision,'message-7','verified-7')]});
  const next=await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[ids[1]!],
    evidence:[receipt(ids[1]!,draft.previews[1]!.revision,'message-7','verified-7')]});
  assert.equal(next.records[0]!.status,'REVIEW_REQUIRED');
  const state=await f.store.snapshot();
  assert.equal(state.historicalPublications.filter(x=>x.status==='PUBLISHED_VERIFIED').length,1);
  assert.equal(state.historicalPublications[1]!.proof,undefined);
 }finally{await f.close()}
});

test('B4 legacy integration: existing B4 delivery reservation is never reclassified by historical migration',async()=>{
 const f=await fixture();try{
  const id=f.resources[0]!.id, draft=await f.publication().draft(OWNER,SOURCE,DEST,[id]);
  await f.publication().approve(OWNER,draft.id);
  await assert.rejects(f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[]}),
    /DELIVERY_ALREADY_RESERVED/);
  const state=await f.store.snapshot();
  assert.equal(state.deliveries[0]!.status,'QUEUED');
  assert.deepEqual(state.historicalPublications,[]);
 }finally{await f.close()}
});

test('B4 legacy integration: concurrent review cannot reserve the same historical item twice',async()=>{
 const f=await fixture();try{
  const id=f.resources[0]!.id;
  const args={sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[]};
  const settled=await Promise.allSettled([f.review().review(OWNER,args),f.review().review(OWNER,args)]);
  assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(settled.filter(x=>x.status==='rejected').length,1);
  assert.equal((await f.store.snapshot()).historicalPublications.length,1);
 }finally{await f.close()}
});

test('B4 legacy integration: v6 to v7 retains existing B4 delivery and B3 records, then persists historical reviews',async()=>{
 const f=await fixture();try{
  const draft=await f.publication().draft(OWNER,SOURCE,DEST,[f.resources[2]!.id]);
  await f.publication().approve(OWNER,draft.id);
  const historic=await f.store.snapshot();
  await writeFile(f.file,JSON.stringify({...historic,schemaVersion:6}));
  const migrated=await new BotStore(f.file).snapshot();
  assert.equal(migrated.schemaVersion,8);
  assert.deepEqual(migrated.campaigns,historic.campaigns);
  assert.deepEqual(migrated.deliveries,historic.deliveries);
  assert.deepEqual(migrated.educationResources,historic.educationResources);
  assert.deepEqual(migrated.historicalPublications,[]);
  const id=f.resources[0]!.id;
  await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[]});
  const reloaded=await new BotStore(f.file).snapshot();
  assert.equal(reloaded.historicalPublications.length,1);
  assert.equal(reloaded.deliveries.length,1);
  await writeFile(f.file,JSON.stringify({...reloaded,historicalPublications:null}));
  await assert.rejects(new BotStore(f.file).snapshot(),/Unsupported state schema/);
 }finally{await f.close()}
});

test('B4 legacy integration: unpublished or archived source cannot enter migration review',async()=>{
 const f=await fixture();try{
  const id=f.resources[0]!.id;
  await f.education.archiveResource(OWNER,id);
  await assert.rejects(f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[]}),/RESOURCE_NOT_PUBLISHED_OR_DISABLED/);
  assert.deepEqual((await f.store.snapshot()).historicalPublications,[]);
 }finally{await f.close()}
});

test('B4 legacy integration: a historical verified receipt cannot be reused by a new single-part dispatch',async()=>{
 const f=await fixture();try{
  const a=f.resources[0]!.id,b=f.resources[1]!.id;
  const source=await f.publication().draft(OWNER,SOURCE,DEST,[a]);
  await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[a],
   evidence:[receipt(a,source.previews[0]!.revision,'mock-message-1','verified-a')]});
  const campaign=await f.publication().draft(OWNER,SOURCE,DEST,[b]);
  await f.publication().approve(OWNER,campaign.id);
  assert.equal((await f.publication().dispatchNext(campaign.id)).status,'UNKNOWN_OUTCOME');
  assert.equal(f.gateway.calls.length,1);
  const state=await f.store.snapshot();
  assert.equal(state.deliveries[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal(state.historicalPublications[0]!.status,'PUBLISHED_VERIFIED');
  assert.equal((await f.publication().dispatchNext(campaign.id)).status,'EMPTY');
 }finally{await f.close();}
});

test('B4 legacy integration: multipart parts never confirm a Telegram message ID already certified as historical',async()=>{
 const f=await fixture();try{
  const a=f.resources[0]!.id,b=f.resources[1]!.id;
  const source=await f.publication().draft(OWNER,SOURCE,DEST,[a]);
  await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[a],
   evidence:[receipt(a,source.previews[0]!.revision,'mock-message-1','verified-a')]});
  await f.education.setPublicationText(OWNER,b,'منحة طويلة معتمدة ومراجعة. '.repeat(300));
  const campaign=await f.publication().draft(OWNER,SOURCE,DEST,[b]);
  await f.publication().approve(OWNER,campaign.id);
  assert.equal((await f.publication().dispatchNext(campaign.id)).status,'UNKNOWN_OUTCOME');
  const state=await f.store.snapshot();
  assert.equal(state.deliveries[0]!.status,'MULTIPART');
  assert.equal(state.deliveries[0]!.multipart!.parts[0]!.status,'UNKNOWN_OUTCOME');
  assert.equal(state.deliveries[0]!.multipart!.parts[1]!.status,'QUEUED');
  assert.equal(f.gateway.calls.length,1);
  assert.equal((await f.publication().dispatchNext(campaign.id)).status,'BLOCKED');
 }finally{await f.close();}
});

test('B4 legacy reconciliation: UNVERIFIED can be settled later with exact trusted evidence without releasing the reservation',async()=>{
 const f=await fixture();try{
  const id=f.resources[0]!.id,draft=await f.publication().draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[]});
  const record=(await f.store.snapshot()).historicalPublications[0]!;
  await assert.rejects(f.review().reconcileEvidence(OWNER,record.id,
    receipt(id,draft.previews[0]!.revision,'message-late','forged-proof')),/RECEIPT_NOT_VERIFIED/);
  assert.equal((await f.store.snapshot()).historicalPublications[0]!.status,'UNVERIFIED');
  const confirmed=await f.review().reconcileEvidence(OWNER,record.id,
    receipt(id,draft.previews[0]!.revision,'message-late','verified-late'));
  assert.equal(confirmed.status,'PUBLISHED_VERIFIED');
  assert.equal(confirmed.proof?.messageId,'message-late');
  assert.equal((await new BotStore(f.file).snapshot()).historicalPublications[0]!.status,'PUBLISHED_VERIFIED');
  await assert.rejects(f.publication().approve(OWNER,draft.id),/HISTORICAL_REVIEW_BLOCKS_REPUBLICATION/);
 }finally{await f.close()}
});

test('B4 legacy reconciliation: verified publication cannot be silently converted into a manual skip',async()=>{
 const f=await fixture();try{
  const id=f.resources[0]!.id,draft=await f.publication().draft(OWNER,SOURCE,DEST,[f.resources[0]!.id]);
  await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],
   evidence:[receipt(id,draft.previews[0]!.revision,'message-9','verified-9')]});
  const record=(await f.store.snapshot()).historicalPublications[0]!;
  await assert.rejects(f.review().markManuallySkipped(OWNER,record.id,'تجاوز بعد الإثبات'),/REVIEW_ALREADY_SETTLED/);
  assert.equal((await f.store.snapshot()).historicalPublications[0]!.status,'PUBLISHED_VERIFIED');
 }finally{await f.close()}
});

test('B4 legacy reconciliation: explicit late manual skip stays distinct from a verified publication',async()=>{
 const f=await fixture();try{
  const id=f.resources[1]!.id;
  await f.review().review(OWNER,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[]});
  const record=(await f.store.snapshot()).historicalPublications[0]!;
  await f.review().markManuallySkipped(OWNER,record.id,'المالك قرر عدم الترحيل');
  const s=await new BotStore(f.file).snapshot();
  assert.equal(s.historicalPublications[0]!.status,'MANUALLY_SKIPPED');
  assert.equal(s.historicalPublications[0]!.proof,undefined);
  assert.equal(s.historicalPublications[0]!.skip?.reason,'المالك قرر عدم الترحيل');
 }finally{await f.close()}
});

test('B4 legacy reconciliation: revocation during evidence verification cannot change an earlier UNKNOWN review',async()=>{
 const f=await fixture();try{
  await f.policy.grant(OWNER,EDITOR,'content.publish',SOURCE,20_000);
  await f.policy.grant(OWNER,EDITOR,'content.publish',DEST,20_000);
  const id=f.resources[0]!.id,draft=await f.publication().draft(EDITOR,SOURCE,DEST,[id]);
  await f.review().review(EDITOR,{sourceScope:SOURCE,destination:DEST,resourceIds:[id],evidence:[]});
  const record=(await f.store.snapshot()).historicalPublications[0]!;
  f.setVerifier(async()=>{await f.policy.revokeGrant(OWNER,EDITOR,'content.publish',SOURCE);return true;});
  await assert.rejects(f.review().reconcileEvidence(EDITOR,record.id,
    receipt(id,draft.previews[0]!.revision,'message-revoked','verified-revoked')),/PUBLISH_DENIED/);
  assert.equal((await f.store.snapshot()).historicalPublications[0]!.status,'UNVERIFIED');
 }finally{await f.close()}
});
