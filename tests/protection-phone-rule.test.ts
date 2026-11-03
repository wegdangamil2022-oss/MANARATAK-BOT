import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {evaluateProtectionRules,isValidProtectionPolicy,protectionRuleFingerprint,type ProtectionPolicy} from '../src/protection-rules.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {protectionMediaFromMessage} from '../src/telegram-protection-media.js';
import {protectionEntityLinks,protectionHasPhoneEntity} from '../src/protection-message-entities.js';
const NOW=1700000000000,base:ProtectionPolicy={chatId:'-100',revision:1,mode:'MONITOR',rules:[{id:'phone',kind:'PHONE',enabled:true,action:'REVIEW'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
const route=(s:OwnerInlineScreen|null,prefix:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));assert.ok(b,prefix);return b.callback_data;};
test('phone policy detects bounded international numbers, verified metadata and text vCards without treating ordinary IDs as phones',()=>{
 const check=(text:string,phoneEntity=false)=>evaluateProtectionRules(base,{chatId:'-100',memberId:'300',type:'TEXT',text,phoneEntity},NOW);
 assert.equal(isValidProtectionPolicy(base),true);assert.equal(check('اتصل +967 712 345 678').status,'MATCH');assert.equal(check('اتصل +٩٦٧ ٧١٢ ٣٤٥ ٦٧٨').status,'MATCH');assert.equal(check('رقم محلي 712345678',true).status,'MATCH');assert.equal(check('BEGIN:VCARD\nVERSION:3.0\nFN:Private Name\nEND:VCARD').status,'MATCH');assert.equal(check('طلب رقم 123456789012').status,'CLEAR');assert.equal(check('+1234567').status,'CLEAR');assert.equal(check('+1234567890123456').status,'CLEAR');assert.equal(check('BEGIN:VCARD without an end').status,'CLEAR');
 assert.equal(evaluateProtectionRules(base,{chatId:'-100',memberId:'300',type:'DOCUMENT',caption:'',vcardFile:true},NOW).status,'MATCH');assert.equal(evaluateProtectionRules(base,{chatId:'-100',memberId:'300',type:'TEXT',text:'x',vcardFile:true},NOW).status,'INVALID_MESSAGE');
 assert.equal(evaluateProtectionRules(base,{chatId:'-100',memberId:'300',type:'CONTACT',caption:''},NOW).status,'MATCH');
 assert.equal(evaluateProtectionRules({...base,rules:[{...base.rules[0],enabled:false}]},{chatId:'-100',memberId:'300',type:'CONTACT',caption:''},NOW).status,'CLEAR');
 assert.equal(evaluateProtectionRules({...base,rules:[{...base.rules[0],extra:true}]},{chatId:'-100',memberId:'300',type:'TEXT',text:'x'},NOW).status,'INVALID_POLICY');assert.equal(evaluateProtectionRules(base,{chatId:'-100',memberId:'300',type:'TEXT',text:'x',phoneEntity:'yes'},NOW).status,'INVALID_MESSAGE');
});
test('vCard document classification uses exact metadata without returning file names or IDs',()=>{
 const parse=(name:string,mime:string)=>protectionMediaFromMessage({document:{file_id:'SECRET_FILE',file_name:name,mime_type:mime}});
 for(const [name,mime,wanted] of [['contact.VCF','application/octet-stream',true],['file.dat','text/vcard',true],['normal.pdf','application/pdf',false],['contact.vcf\n','text/vcard\n',false]] as const){const result=parse(name,mime);assert.equal(result.status,'MEDIA');if(result.status==='MEDIA')assert.equal(result.media.vcardFile===true,wanted);assert.equal(JSON.stringify(result).includes('SECRET_FILE'),false);assert.equal(JSON.stringify(result).includes(name),false);}
});
test('telephone links are classified as phone metadata and malformed links fail closed',()=>{
 const entity=(url:string)=>[{type:'text_link',offset:0,length:4,url}];
 for(const value of ['tel:+967712345678','TEL:712-345-678']){
  assert.deepEqual(protectionEntityLinks('اتصل',entity(value)),[]);
  assert.equal(protectionHasPhoneEntity('اتصل',entity(value)),true);
 }
 for(const value of ['tel:+123','tel:+967712345678\n','tel:+967712345678;ext=1'])assert.equal(protectionEntityLinks('اتصل',entity(value)),null);
 assert.deepEqual(protectionEntityLinks('اتصل',entity('https://example.com')),['https://example.com']);
});
test('contact and phone rules combine without bypassing an independent rule exemption',()=>{
 const phone=base.rules[0]!;
 const config:ProtectionPolicy={...base,rules:[phone,{id:'contact',kind:'TYPE',type:'CONTACT',enabled:true,action:'DELETE'}],ruleExemptions:[{memberId:'300',ruleId:'phone',ruleDigest:protectionRuleFingerprint(phone),createdAt:NOW,expiresAt:NOW+60000,grantedBy:'100'}]};
 const message={chatId:'-100',memberId:'300',type:'CONTACT' as const,caption:''};
 const exempt=evaluateProtectionRules(config,message,NOW);assert.deepEqual(exempt.matchedRuleIds,['contact']);assert.equal(exempt.proposedAction,'DELETE');
 const expired=evaluateProtectionRules(config,message,NOW+60000);assert.deepEqual(expired.matchedRuleIds,['contact','phone']);assert.equal(expired.proposedAction,'DELETE');
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' validated phone entities and vCards are monitored without storing the sensitive text',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-rule-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100','-100',['moderation']);const service=new GroupProtectionPolicyService(store,policy,()=>NOW);assert.equal((await service.save('100',base,1,0)).status,'SAVED');
   assert.equal(await service.observeIncomingText('300','-100','اتصل 712345678',[{type:'phone_number',offset:5,length:9}],'b3-webhook:phone:1'),'OBSERVED');assert.equal(await service.observeIncomingText('300','-100','BEGIN:VCARD\nFN:SECRET PERSON\nEND:VCARD',[],'b3-webhook:phone:2'),'OBSERVED');
   assert.equal(await service.observeIncomingText('300','-100','😀',[{type:'phone_number',offset:1,length:1}],'b3-webhook:phone:3'),'UNAVAILABLE');
   assert.equal(await service.observeIncomingText('300','-100','اتصل',[{type:'text_link',offset:0,length:4,url:'tel:+967712345678'}],'b3-webhook:phone:4'),'OBSERVED');
   assert.equal(await service.observeIncomingText('300','-100','اتصل',[{type:'text_link',offset:0,length:4,url:'tel:+123'}],'b3-webhook:phone:5'),'UNAVAILABLE');
   const state=await store.snapshot();assert.equal(state.audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')).length,3);assert.equal(JSON.stringify(state).includes('712345678'),false);assert.equal(JSON.stringify(state).includes('SECRET PERSON'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' phone rule picker, duplicate prevention, activation and back work independently of contact rules',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phone-rule-ui-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100','-100',['moderation']);const ui=new TelegramProtectionEditor(store,policy,()=>NOW),home=async()=>ui.handle((await ui.link('100','-100'))!,'100');
   let group=await home(),picker=await ui.handle(route(group,'pr:1:y:'),'100'),next=picker!.keyboard.inline_keyboard.flat().find(b=>b.text.includes('التالي'));assert.ok(next);picker=await ui.handle(next.callback_data,'100');const choose=picker!.keyboard.inline_keyboard.flat().find(b=>b.text.includes('vCard'));assert.ok(choose);assert.ok(await ui.handle(choose.callback_data,'100'));
   let state=await store.snapshot();assert.deepEqual(state.protectionPolicies![0]!.policy.rules.map(r=>[r.kind,r.enabled,r.action]),[['PHONE',false,'REVIEW']]);
   group=await home();picker=await ui.handle(route(group,'pr:1:y:'),'100');next=picker!.keyboard.inline_keyboard.flat().find(b=>b.text.includes('التالي'));assert.ok(next);picker=await ui.handle(next.callback_data,'100');assert.ok(await ui.handle(picker!.keyboard.inline_keyboard.flat().find(b=>b.text.includes('vCard'))!.callback_data,'100'));assert.equal((await store.snapshot()).protectionPolicies![0]!.policy.rules.length,1);
   group=await home();let list=await ui.handle(route(group,'pr:1:l:'),'100'),detail=await ui.handle(route(list,'pr:1:r:'),'100');assert.match(detail!.text,/vCard/u);assert.match(detail!.text,/جهات الاتصال/u);assert.ok(await ui.handle(route(detail,'pr:1:e:'),'100'));state=await store.snapshot();assert.equal(state.protectionPolicies![0]!.policy.rules[0]!.enabled,true);
   group=await home();list=await ui.handle(route(group,'pr:1:l:'),'100');detail=await ui.handle(route(list,'pr:1:r:'),'100');const back=detail!.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('pr:1:l:'));assert.ok(back);assert.ok(await ui.handle(back.callback_data,'100'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
