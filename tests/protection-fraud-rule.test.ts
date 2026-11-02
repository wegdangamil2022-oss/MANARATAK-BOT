import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateProtectionRules,isValidProtectionPolicy} from '../src/protection-rules.js';

test('fraud rule requires both distinct configured phrases and only proposes review',()=>{
 const rule={id:'fraud1',kind:'FRAUD' as const,identity:'ممثل منارتك',payment:'رسوم التسجيل',enabled:true,action:'REVIEW' as const};
 const policy={chatId:'-100123',revision:1,mode:'MONITOR' as const,rules:[rule],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
 const evaluate=(text:string)=>evaluateProtectionRules(policy,{chatId:'-100123',memberId:'300',type:'TEXT',text},1700000000000);
 assert.equal(isValidProtectionPolicy(policy),true);
 assert.equal(evaluate('ممثل منارتك يشرح الشروط').status,'CLEAR');
 assert.equal(evaluate('الجامعة تذكر رسوم التسجيل').status,'CLEAR');
 assert.equal(evaluate('ممثل منارتك يطلب رسوم التسجيل').status,'MATCH');
 assert.equal(evaluate('رسوم التسجيل يطلبها ممثل منارتك').proposedAction,'REVIEW');
 assert.equal(evaluate('ممثل منارتك يطلب رسوم التسجيل').authorizedToSend,false);
 assert.equal(isValidProtectionPolicy({...policy,rules:[{...rule,payment:'ممثل منارتك'}]}),false);
 assert.equal(evaluateProtectionRules({...policy,rules:[{...rule,enabled:false}]},{chatId:'-100123',memberId:'300',type:'TEXT',text:'ممثل منارتك رسوم التسجيل'},1700000000000).status,'CLEAR');
 assert.equal(evaluateProtectionRules({...policy,allowedPhrases:['ممثل منارتك']},{chatId:'-100123',memberId:'300',type:'TEXT',text:'ممثل منارتك رسوم التسجيل'},1700000000000).status,'CLEAR');
 const overlap={...policy,rules:[{...rule,identity:'منارتك',payment:'ممثل منارتك'}]};
 assert.equal(evaluateProtectionRules(overlap,{chatId:'-100123',memberId:'300',type:'TEXT',text:'ممثل منارتك'},1700000000000).status,'CLEAR');
 assert.equal(evaluateProtectionRules(overlap,{chatId:'-100123',memberId:'300',type:'TEXT',text:'ممثل منارتك لمنارتك'},1700000000000).status,'CLEAR');
 assert.equal(evaluateProtectionRules(overlap,{chatId:'-100123',memberId:'300',type:'TEXT',text:'ممثل منارتك منارتك'},1700000000000).status,'MATCH');
});

test('lookalike rule respects exact trusted domains and flags bounded host imitation without fetching links',()=>{
 const rule={id:'look1',kind:'LOOKALIKE' as const,domain:'example.org',enabled:true,action:'REVIEW' as const};
 const policy={chatId:'-100123',revision:1,mode:'MONITOR' as const,rules:[rule],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
 const check=(url:string)=>evaluateProtectionRules(policy,{chatId:'-100123',memberId:'300',type:'TEXT',text:url},1700000000000).status;
 assert.equal(check('https://example.org/login'),'CLEAR');assert.equal(check('https://apply.example.org'),'CLEAR');
 assert.equal(check('https://examp1e.org'),'MATCH');assert.equal(check('https://exmaple.org'),'MATCH');
 assert.equal(check('https://example.org.evil.net'),'MATCH');assert.equal(check('https://account.example.org.evil.net'),'MATCH');
 assert.equal(check('https://example.net'),'CLEAR');
 assert.equal(evaluateProtectionRules(policy,{chatId:'-100123',memberId:'300',type:'TEXT',text:'اضغط هنا',links:['https://examp1e.org']},1700000000000).status,'MATCH');
 assert.equal(evaluateProtectionRules({...policy,allowedDomains:['examp1e.org']},{chatId:'-100123',memberId:'300',type:'TEXT',text:'https://examp1e.org'},1700000000000).status,'CLEAR');
 for(const domain of ['https://example.org','EXAMPLE.ORG','localhost','127.0.0.1','example.org/path','example..org','-example.org','example-.org'])assert.equal(isValidProtectionPolicy({...policy,rules:[{...rule,domain}]}),false);
});
