import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from './store.js';
import { Policy } from './policy.js';
import { EducationService } from './education.js';
import { ApprovedAnswerService, ResourceLinkService } from './education-interactions.js';
import { EducationAdminFacade } from './education-admin.js';

// Synthetic end-to-end application-layer demonstration. No Telegram, external API or AI connection.
const root=await mkdtemp(join(tmpdir(),'manaratak-b3-faq-'));
try {
  const store=new BotStore(join(root,'simulation.json'));
  const policy=new Policy(store,'100');
  const education=new EducationService(store,policy);
  const faq=new ApprovedAnswerService(store,policy);
  const links=new ResourceLinkService(store,policy);
  const panel=new EducationAdminFacade(store,policy,education);
  const owner={actorId:'100',chatId:'100',origin:'TELEGRAM_PRIVATE' as const,verified:true};
  await policy.approveChat('100','-100',['navigation','assistant']);
  await policy.configureGroupAI('100','-100','ALL_MENTION');
  await education.createCategory('100',{id:'scholarships',scope:'-100',title:'Scholarships',order:1});
  console.log('Owner panel (simulated):',await panel.panel(owner,'-100'));
  const uploaded=await panel.upload(owner,'-100','csv','sample.csv','title,university,cycle\nExample Scholarship,Example University,2026\n');
  await panel.approve(owner,uploaded.id,0,'scholarships');
  const resource=await panel.publish(owner,uploaded.id,0,'scholarships');
  const submitted=await faq.submit('100','-100',{question:'Which scholarship?',aliases:['Example grant'],answer:'See the approved example resource.',sourceResourceId:resource.id});
  console.log('FAQ before approval:',await faq.answerGroup('400','-100','Which scholarship?',true));
  await faq.approve('100',submitted.id);
  console.log('FAQ after approval:',await faq.answerGroup('400','-100','Example grant',true));
  const ref=await links.issue('100',resource.id,Date.now()+600_000);
  console.log('Link without membership evidence:',(await links.resolve(ref,'400',async()=> 'UNKNOWN')).status);
  console.log('Link after mock VERIFIED proof:',(await links.resolve(ref,'400',async()=> 'VERIFIED')).status);
} finally { await rm(root,{recursive:true,force:true}); }
