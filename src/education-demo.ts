import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from './store.js';
import { Policy } from './policy.js';
import { EducationService } from './education.js';

// Only synthetic data. Never connects to Telegram, AI, or MANARATAK platform.
const temp = await mkdtemp(join(tmpdir(), 'manaratak-b3-demo-'));
try {
  const store = new BotStore(join(temp, 'sandbox.json'));
  const policy = new Policy(store, '100');
  const edu = new EducationService(store, policy);
  await policy.approveChat('100', '-100', ['navigation']);
  await edu.createCategory('100', {id:'scholarships',scope:'-100',title:'المنح',order:1});
  const run = await edu.submitText('100', '-100', 'TELEGRAM_ADMIN', 'csv', 'sample.csv',
    'university,title,cycle,degree,seats\nSample University,Example Scholarship,2026,Bachelor,5\n');
  console.log('Import report (synthetic):',run.report);
  console.log('Before approval:',(await edu.listResources('400','-100','scholarships')).length);
  await edu.approveCandidate('100',run.id,0,'scholarships');
  await edu.publishCandidate('100',run.id,0,'scholarships');
  console.log('After manual approval + publication:',(await edu.listResources('400','-100','scholarships')).length);
} finally { await rm(temp,{recursive:true,force:true}); }
