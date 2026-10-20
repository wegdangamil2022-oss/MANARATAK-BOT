import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from './store.js';
import { Policy } from './policy.js';
import { EducationService } from './education.js';
import { FakePublicationGateway, PublicationService } from './publishing.js';

const folder = await mkdtemp(join(tmpdir(),'manaratak-b4-demo-'));
try {
  const store = new BotStore(join(folder,'offline.json'));
  const clock = () => 2_000;
  const policy = new Policy(store,'100',clock);
  const education = new EducationService(store,policy,clock);
  const fake = new FakePublicationGateway(); // NO network
  const publishing = new PublicationService(store,policy,fake,clock);
  await policy.approveChat('100','-100',['navigation']);
  await policy.approveChat('100','-200',['publishing']);
  await education.createCategory('100',{id:'grants',scope:'-100',title:'المنح',order:1});
  const imp=await education.submitText('100','-100','ADMIN_WEB','csv','demo.csv',
    'university,title,cycle,degree,seats\nExample University,Example Scholarship,2026,Bachelor,3');
  await education.approveCandidate('100',imp.id,0,'grants');
  const resource=await education.publishCandidate('100',imp.id,0,'grants');
  const campaign=await publishing.draft('100','-100','-200',[resource.id]);
  console.log('PREVIEW (synthetic only):',campaign.previews[0]!.text);
  console.log('Before approval:',(await store.snapshot()).deliveries.length,'deliveries');
  await publishing.approve('100',campaign.id);
  console.log('After explicit approval:',(await store.snapshot()).deliveries[0]!.status);
  console.log('Fake dispatch:',await publishing.dispatchNext(campaign.id));
  console.log('Provider calls (fake only):',fake.calls.length);
  const restarted=new PublicationService(new BotStore(store.file),policy,fake,clock);
  console.log('After restart:',await restarted.dispatchNext(campaign.id));
} finally { await rm(folder,{recursive:true,force:true}); }
