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
});
