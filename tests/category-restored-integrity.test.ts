import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {ApprovedAnswerService} from '../src/education-interactions.js';
import {renderStudentInline} from '../src/telegram-inline-student.js';
for(const engine of ['json','sqlite'] as const){
 test(engine+' restored category cycles and duplicate ancestors fail closed for student browsing and FAQ',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'category-integrity-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  const policy=new Policy(store,'100'),education=new EducationService(store,policy),faq=new ApprovedAnswerService(store,policy);
  try{
   await education.createCategory('100',{id:'root',scope:'private',title:'جذر',order:1});
   await education.createCategory('100',{id:'child',scope:'private',title:'فرع',order:2,parentId:'root'});
   await store.transaction(s=>{
    s.educationResources.push({id:'resource',categoryId:'child',scope:'private',title:'منحة',university:'جامعة',cycle:'2026',degree:'بكالوريوس',seats:null,sourceImportId:'local',sourceLocator:'row',reviewedBy:'100',status:'PUBLISHED'});
    s.faqEntries.push({id:'faq',scope:'private',question:'كيف أقدم',aliases:[],answer:'الإجابة',sourceResourceId:'resource',createdBy:'100',createdAt:1,status:'APPROVED'});
   });
   assert.equal((await education.listCategories('300','private')).length,2);
   assert.equal((await faq.listPrivateReviewedFAQs('300')).items.length,1);
   await store.transaction(s=>{s.educationCategories.find(c=>c.id==='root')!.parentId='child';});
   assert.deepEqual(await education.listCategories('300','private'),[]);
   assert.deepEqual(await education.searchPublishedResources('300','منحة'),[]);
   assert.equal((await faq.listPrivateReviewedFAQs('300')).items.length,0);
   const cyclic=await renderStudentInline(store,policy,'300','si:1:h');assert.ok(cyclic);assert.doesNotMatch(cyclic!.text,/منحة|فرع/);
   await store.transaction(s=>{s.educationCategories.find(c=>c.id==='root')!.parentId=null;s.educationCategories.push({...s.educationCategories.find(c=>c.id==='root')!});});
   assert.deepEqual(await education.listCategories('300','private'),[]);
   assert.equal((await faq.listPrivateReviewedFAQs('300')).items.length,0);
   const duplicated=await renderStudentInline(store,policy,'300','si:1:h');assert.ok(duplicated);assert.doesNotMatch(JSON.stringify(duplicated),/فرع|جذر/);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
