import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultGreetingSettings,validateGreetingSettings,decideGreeting,renderGreetingTemplate,
 type GreetingSettings,type InteractionEvent} from '../src/phase4-welcome-engine.js';
const chat='-100123456';
const event:InteractionEvent={updateKey:'upd-1',chatId:chat,actorId:'310',kind:'JOIN',at:1_000_000,
 trusted:true,chatApproved:true,memberName:'Ali & <team>',groupName:'منارتك',verified:true};
const settings=():GreetingSettings=>({...defaultGreetingSettings(chat),enabled:true,welcomeMode:'GROUP',
 welcomeTemplateId:'hello',templates:[{id:'hello',language:'ar',text:'أهلاً {العضو} في {اسم_المجموعة}!\nاليوم {التاريخ}'}]});
const evaluate=(s:GreetingSettings,e:InteractionEvent=event)=>decideGreeting(s,e,[]);
test('phase4: opt-in default and approved group are mandatory',()=>{
 const off=defaultGreetingSettings(chat);assert.equal(validateGreetingSettings(off),true);
 assert.equal(decideGreeting(off,event,[]).status,'DISABLED');
 assert.equal(evaluate(settings(),{...event,chatApproved:false}).status,'UNAPPROVED');
 assert.equal(evaluate(settings(),{...event,chatId:'-987'}).status,'UNTRUSTED');
});
test('phase4: escape injected member/group text and preserve safe welcome placeholders',()=>{
 const d=evaluate(settings());assert.equal(d.status,'READY');
 assert.match(d.rendered?.html??'',/Ali &amp; &lt;team&gt;/);
 assert.equal(d.receipt.ruleId,'welcome');
 assert.equal(d.rendered?.templateId,'hello');
});
test('phase4: forwarded, edited, forged, bot and invalid actors are denied',()=>{
 for(const e of [{...event,trusted:false},{...event,forwarded:true},{...event,edited:true},
  {...event,botActor:true},{...event,actorId:'-2'},{...event,topicId:-1}])
  assert.notEqual(evaluate(settings(),e).status,'READY');
});
test('phase4: verification-only welcome must wait for onboarding',()=>{
 const s={...settings(),welcomeMode:'VERIFIED_ONLY' as const,verifiedTemplateId:'hello'};
 assert.equal(evaluate(s,{...event,verified:false}).status,'ONBOARDING_REQUIRED');
 assert.equal(evaluate(s).status,'READY');
});
test('phase4: optional farewell stays OFF independently',()=>{
 assert.equal(evaluate(settings(),{...event,kind:'LEAVE'}).status,'DISABLED');
 const s={...settings(),farewellEnabled:true,farewellTemplateId:'hello'};
 assert.equal(evaluate(s,{...event,kind:'LEAVE'}).status,'READY');
});
test('phase4: keyword rule ordering and nonmatching keywords',()=>{
 const s={...settings(),replyRules:[
  {id:'one',enabled:true,trigger:'KEYWORD' as const,match:'WORD' as const,phrase:'منحة',
   templateId:'hello',priority:2,cooldownUserMs:1000,cooldownTopicMs:0},
  {id:'two',enabled:true,trigger:'KEYWORD' as const,match:'CONTAINS' as const,phrase:'منحة',
   templateId:'hello',priority:1,cooldownUserMs:0,cooldownTopicMs:0}]};
 const d=evaluate(s,{...event,kind:'KEYWORD',text:'كيف أقدم لمنحة؟'});
 assert.equal(d.status,'READY');assert.equal(d.rendered?.ruleId,'two');
 assert.equal(evaluate(s,{...event,kind:'KEYWORD',text:'لا يوجد تطابق'}).status,'NO_MATCH');
});
test('phase4: Arabic word boundaries and diacritic removal',()=>{
 const s={...settings(),replyRules:[{id:'faq',enabled:true,trigger:'KEYWORD' as const,
  match:'WORD' as const,phrase:'مِنْحة',templateId:'hello',priority:0,cooldownUserMs:0,cooldownTopicMs:0}]};
 assert.equal(evaluate(s,{...event,kind:'KEYWORD',text:'أريد منحة الآن'}).status,'READY');
 assert.equal(evaluate(s,{...event,kind:'KEYWORD',text:'المنحة الآن'}).status,'NO_MATCH');
});
test('phase4: exact Telegram commands do not match longer commands',()=>{
 const s={...settings(),replyRules:[{id:'start',enabled:true,trigger:'COMMAND' as const,
  match:'EXACT' as const,phrase:'/guide',templateId:'hello',priority:0,cooldownUserMs:0,cooldownTopicMs:0}]};
 assert.equal(evaluate(s,{...event,kind:'COMMAND',text:'/guide'}).status,'READY');
 assert.equal(evaluate(s,{...event,kind:'COMMAND',text:'/guide hello'}).status,'READY');
 assert.equal(evaluate(s,{...event,kind:'COMMAND',text:'/guides'}).status,'NO_MATCH');
});
test('phase4: rule-scoped cooldown does not affect another forum topic',()=>{
 const s={...settings(),replyRules:[{id:'faq',enabled:true,trigger:'KEYWORD' as const,
  match:'EXACT' as const,phrase:'سؤال',templateId:'hello',priority:0,cooldownUserMs:0,cooldownTopicMs:10000}]};
 const e={...event,kind:'KEYWORD' as const,text:'سؤال',topicId:10};
 const first=evaluate(s,e);assert.equal(first.status,'READY');
 assert.equal(decideGreeting(s,{...e,updateKey:'two',actorId:'311',at:e.at+1},[first.receipt]).status,'RATE_LIMIT');
 assert.equal(decideGreeting(s,{...e,updateKey:'three',actorId:'311',topicId:11,at:e.at+1},[first.receipt]).status,'READY');
});
test('phase4: replay and user cooldown are both idempotent',()=>{
 const s=settings(),first=evaluate(s);
 assert.equal(decideGreeting(s,event,[first.receipt]).status,'REPLAY');
 assert.equal(decideGreeting(s,{...event,updateKey:'new',at:event.at+1},[first.receipt]).status,'RATE_LIMIT');
 assert.equal(decideGreeting(s,{...event,updateKey:'new',at:event.at+s.welcomeCooldownMs},[first.receipt]).status,'READY');
});
test('phase4: quiet hours wrap midnight; lectures pause all automatic messages',()=>{
 const start=Date.UTC(2026,0,1,21);
 const s={...settings(),timezone:'UTC',quietHours:{startHour:20,endHour:7}};
 assert.equal(evaluate(s,{...event,at:start}).status,'QUIET');
 assert.equal(evaluate(s,{...event,at:Date.UTC(2026,0,1,12)}).status,'READY');
 assert.equal(evaluate({...settings(),timezone:'UTC',lectureUntil:start+1},{...event,at:start}).status,'LECTURE');
});
test('phase4: unsafe templates, links, unknown variables and commands never validate',()=>{
 const s=settings();
 assert.equal(validateGreetingSettings({...s,templates:[{id:'hello',language:'ar',text:'{سري}'}]}),false);
 assert.equal(validateGreetingSettings({...s,templates:[{id:'hello',language:'ar',text:'عادي',
  buttons:[{label:'خطير',url:'javascript:alert(1)'}]}]}),false);
 assert.equal(validateGreetingSettings({...s,timezone:'Bad/Timezone'}),false);
 assert.equal(validateGreetingSettings({...s,replyRules:[{id:'one',enabled:true,trigger:'COMMAND',match:'EXACT',
  phrase:'/start;rm',templateId:'hello',priority:0,cooldownUserMs:0,cooldownTopicMs:0}]}),false);
});
test('phase4: Gregorian and Hijri templates are timezone-aware',()=>{
 const s=settings(),t=s.templates[0]!;
 assert.match(renderGreetingTemplate(t,s,event),/اليوم /);
 assert.match(renderGreetingTemplate(t,{...s,calendar:'islamic'},event),/اليوم /);
});