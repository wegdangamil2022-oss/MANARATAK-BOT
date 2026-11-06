import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateProtectionRules,isValidProtectionPolicy,type ProtectionPolicy} from '../src/protection-rules.js';
const base:ProtectionPolicy={chatId:'-100',revision:1,mode:'MONITOR',allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],rules:[{id:'username',kind:'USERNAME',username:'manaratak',trustedId:'123',enabled:true,action:'REVIEW'}]};
test('username impersonation evaluates one edit only and ignores the trusted identity',()=>{
 const check=(memberId:string,username?:string)=>evaluateProtectionRules(base,{chatId:'-100',memberId,type:'TEXT',text:'hello',...(username?{username}:{})},1700000000000);
 assert.equal(isValidProtectionPolicy(base),true);assert.equal(check('300','manaratak').status,'MATCH');assert.equal(check('123','manaratak').status,'CLEAR');assert.equal(check('123','manaratack').status,'CLEAR');assert.equal(check('300','ManaratAk').status,'MATCH');assert.equal(check('300','manaratack').status,'MATCH');assert.equal(check('300','manaratka').status,'MATCH');assert.equal(check('300','other_user').status,'CLEAR');assert.equal(check('300').status,'CLEAR');
});
test('username policies reject malformed, repeated or unsafe references',()=>{
 for(const username of ['Bad Name','a'.repeat(33),'bad\n','ab'])assert.equal(isValidProtectionPolicy({...base,rules:[{id:'x',kind:'USERNAME',username,trustedId:'123',enabled:false,action:'REVIEW'}]}),false);
 assert.equal(isValidProtectionPolicy({...base,rules:[...base.rules,{id:'other',kind:'USERNAME',username:'MANARATAK',trustedId:'456',enabled:false,action:'REVIEW'}]}),false);
});
