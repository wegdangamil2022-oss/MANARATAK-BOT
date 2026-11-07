import type {BotState} from './store.js';
import {visibleEducationCategory} from './education-category-policy.js';
import {validCommunityFAQId,validCommunityRulesUrl,
 type CommunityConfig,type CommunityReplyRule} from './phase4-community-model.js';

/** No student message is copied here. The FAQ author/owner approved the answer,
 * and its referenced publication/category must still be public to this group.
 * No cross-group or private FAQ can ever be imported by an automated reply.
 */
export function reviewedGroupFAQAnswer(state:BotState,scope:string,id:string,
 topicId?:number):string|null {
 if(!validCommunityFAQId(id)||!scope.startsWith('-'))return null;
 const entries=state.faqEntries.filter(q=>q.id===id),entry=entries[0];
 if(entries.length!==1||!entry||entry.scope!==scope||entry.status!=='APPROVED'||
   typeof entry.answer!=='string'||entry.answer.trim().length===0||
   entry.answer.length>1200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry.answer))return null;
 const resources=state.educationResources.filter(r=>r.id===entry.sourceResourceId);
 const source=resources[0];
 if(resources.length!==1||!source||source.scope!==scope||
   source.status!=='PUBLISHED')return null;
 const categories=state.educationCategories.filter(c=>c.id===source.categoryId);
 const cat=categories[0];
 if(categories.length!==1||!cat||cat.scope!==scope||
   !visibleEducationCategory(state,cat,topicId))return null;
 return entry.answer;
}
const escapeTelegram=(text:string):string=>text.replace(/&/gu,'&amp;')
 .replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
/** Resolve only approved sources, at the instant a reply is planned. The normal
 * group-menu policy epoch rechecks FAQ, source/category and community config
 * again just before the irreversible Telegram send attempt. No AI fallback.
 */
export function resolvedCommunityReply(state:BotState,config:CommunityConfig,
 rule:CommunityReplyRule,topicId?:number):{template:string;escaped?:true}|null {
 if(rule.source==='FAQ'){
  const answer=reviewedGroupFAQAnswer(state,config.chatId,rule.sourceFaqId??'',topicId);
  if(answer===null)return null;
  const text='📚 إجابة معتمدة من الأسئلة الشائعة:\n'+escapeTelegram(answer);
  return Buffer.byteLength(text,'utf8')<=4096?{template:text,escaped:true}:null;
 }
 if(rule.source==='RULES'){
  if(!validCommunityRulesUrl(config.rulesUrl))return null;
  return {template:'📜 قوانين المجموعة:\n{رابط_القوانين}'};
 }
 return {template:rule.response};
}
