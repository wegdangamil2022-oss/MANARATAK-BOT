import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateProtectionRules,isValidProtectionPolicy,type ProtectionPolicy,type ProtectionMessage} from '../src/protection-rules.js';
const policy=(rules:ProtectionPolicy['rules']):ProtectionPolicy=>({chatId:'-100',revision:1,mode:'MONITOR',rules,allowedDomains:['school.edu'],allowedPhrases:[],exemptMemberIds:[]});
const message=(text:string):ProtectionMessage=>({chatId:'-100',memberId:'300',type:'TEXT',text});
test('word matching normalizes Arabic without matching fragments of other words',()=>{
 const cfg=policy([{id:'word',kind:'WORD',value:'إعلان',action:'DELETE',enabled:true}]);
 assert.equal(evaluateProtectionRules(cfg,message('إِعْــلان')).status,'MATCH');
 assert.equal(evaluateProtectionRules(cfg,message('إعلانات')).status,'CLEAR');
 assert.equal(evaluateProtectionRules(cfg,message('هذا إ\u200bعلان جديد')).status,'MATCH');
});
test('phrases require contiguous normalized words in the same order',()=>{
 const cfg=policy([{id:'phrase',kind:'PHRASE',value:'دفع رسوم',action:'REVIEW',enabled:true}]);
 assert.equal(evaluateProtectionRules(cfg,message('يطلب دَفع، رسوم الآن')).status,'MATCH');
 assert.equal(evaluateProtectionRules(cfg,message('رسوم دون دفع')).status,'CLEAR');
 assert.equal(evaluateProtectionRules(cfg,message('دفع أي رسوم')).status,'CLEAR');
});
test('a medical phrase exception does not bypass a media lock',()=>{
 const cfg=policy([{id:'word',kind:'WORD',value:'حساس',action:'MUTE',enabled:true},{id:'photo',kind:'TYPE',type:'PHOTO',action:'DELETE',enabled:true}]);
 cfg.allowedPhrases=['درس طبي حساس'];
 const result=evaluateProtectionRules(cfg,{chatId:'-100',memberId:'300',type:'PHOTO',caption:'درس طبي حساس'});
 assert.deepEqual(result.matchedRuleIds,['photo']);assert.equal(result.proposedAction,'DELETE');
});
test('an allowed medical phrase exempts its own words without disabling unrelated lexical rules',()=>{
 const cfg=policy([{id:'sensitive',kind:'WORD',value:'حساس',action:'MUTE',enabled:true},{id:'spam',kind:'WORD',value:'spam',action:'DELETE',enabled:true}]);
 cfg.allowedPhrases=['درس طبي حساس'];
 const result=evaluateProtectionRules(cfg,message('درس طبي حساس ثم spam'));
 assert.deepEqual(result.matchedRuleIds,['spam']);assert.equal(result.proposedAction,'DELETE');
});
test('masking an allowed phrase does not join separate words into a prohibited phrase',()=>{
 const cfg=policy([{id:'phrase',kind:'PHRASE',value:'دفع رسوم',action:'DELETE',enabled:true}]);
 cfg.allowedPhrases=['درس طبي'];
 assert.equal(evaluateProtectionRules(cfg,message('دفع درس طبي رسوم')).status,'CLEAR');
});
test('trusted hosts are exact and lookalikes or embedded credentials do not bypass link rules',()=>{
 const cfg=policy([{id:'links',kind:'LINK',hosts:'*',action:'DELETE',enabled:true}]);
 assert.equal(evaluateProtectionRules(cfg,message('https://school.edu/learn')).status,'CLEAR');
 assert.equal(evaluateProtectionRules(cfg,message('https://school.edu.evil.test/learn')).status,'MATCH');
 assert.equal(evaluateProtectionRules(cfg,message('https://school.edu@evil.test/learn')).status,'MATCH');
 assert.equal(evaluateProtectionRules(cfg,message('https://sub.school.edu/learn')).status,'MATCH');
});
test('links in Telegram text entities and captions are checked without fetching them',()=>{
 const cfg=policy([{id:'telegram',kind:'LINK',hosts:['t.me'],action:'WARN',enabled:true}]);
 assert.equal(evaluateProtectionRules(cfg,message('تعال t.me/unknown')).status,'MATCH');
 assert.equal(evaluateProtectionRules(cfg,{chatId:'-100',memberId:'300',type:'PHOTO',caption:'رابط',links:['https://t.me/unknown']}).status,'MATCH');
});
test('several violations produce one strongest proposed action, without a dispatch permission',()=>{
 const cfg=policy([{id:'z',kind:'WORD',value:'spam',action:'WARN',enabled:true},{id:'a',kind:'LINK',hosts:'*',action:'DELETE',enabled:true}]);
 cfg.mode='ENFORCE';
 const result=evaluateProtectionRules(cfg,message('spam https://evil.test'));
 assert.equal(result.proposedAction,'DELETE');assert.deepEqual(result.matchedRuleIds,['a','z']);assert.equal(result.authorizedToSend,false);
});
test('OFF and exempt members produce no action and disabled rules do not match',()=>{
 const cfg=policy([{id:'word',kind:'WORD',value:'spam',action:'MUTE',enabled:false}]);
 assert.equal(evaluateProtectionRules(cfg,message('spam')).status,'CLEAR');
 cfg.mode='OFF';assert.equal(evaluateProtectionRules(cfg,message('spam')).status,'OFF');
 cfg.mode='MONITOR';cfg.exemptMemberIds=['300'];assert.equal(evaluateProtectionRules(cfg,message('spam')).status,'EXEMPT');
});
test('scope mismatch and ambiguous raw message metadata fail closed',()=>{
 const cfg=policy([]);
 assert.equal(evaluateProtectionRules(cfg,{...message('hello'),chatId:'-999'}).status,'INVALID_MESSAGE');
 assert.equal(evaluateProtectionRules(cfg,{...message('hello'),caption:'secret'} as never).status,'INVALID_MESSAGE');
});
test('malformed rules, unknown keys, duplicates and unsupported permanent bans fail closed',()=>{
 const cfg=policy([{id:'word',kind:'WORD',value:'spam',action:'WARN',enabled:true}]);
 for(const bad of [{...cfg,mode:'RUN'},{...cfg,rules:[...cfg.rules,...cfg.rules]},
  {...cfg,rules:[{...cfg.rules[0],action:'BAN'}]}, {...cfg,rules:[{...cfg.rules[0],value:'***'}]},
  {...cfg,rules:[{...cfg.rules[0],regex:'.*'}]}]){
  assert.equal(isValidProtectionPolicy(bad),false);
  assert.equal(evaluateProtectionRules(bad,message('spam')).status,'INVALID_POLICY');
 }
});
test('non-string enum values are rejected without invoking coercion methods',()=>{
 const cfg=policy([]),bad={toString:undefined};
 assert.equal(evaluateProtectionRules({...cfg,mode:bad},message('safe')).status,'INVALID_POLICY');
 assert.equal(evaluateProtectionRules({...cfg,rules:[{id:'x',kind:'TYPE',type:bad,action:'DELETE',enabled:true}]},message('safe')).status,'INVALID_POLICY');
 assert.equal(evaluateProtectionRules(cfg,{...message('safe'),type:bad}).status,'INVALID_MESSAGE');
});
test('evaluation never mutates the policy and never returns message contents',()=>{
 const cfg=policy([{id:'word',kind:'WORD',value:'spam',action:'WARN',enabled:true}]),before=structuredClone(cfg);
 const result=evaluateProtectionRules(cfg,message('spam PRIVATE_STUDENT_TEXT'));
 assert.deepEqual(cfg,before);assert.equal(JSON.stringify(result).includes('PRIVATE_STUDENT_TEXT'),false);
});
