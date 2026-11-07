import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {localForumTopics} from './group-forum-topics.js';
import {forumTopicEducationMode} from './group-forum-topic-policy.js';
import {visibleEducationCategory} from './education-category-policy.js';
import {groupMenuEpochDigest} from './telegram-group-access.js';

/** TOPIC-002 — informational, side-effect-free targeting check.
 * An available local resource is NOT evidence that Telegram currently
 * permits a message to the specific message_thread_id.
 */
export interface ForumTopicEducationalSourcePreview{
 readonly group:string;readonly thread:number;readonly topicTitle:string;
 readonly groupVersion:number;readonly topicPaused:boolean;
 readonly categoryCount:number;readonly resourceCount:number;
 readonly titles:readonly string[];
 readonly epoch:string;readonly ownerAuthorized:boolean;
 readonly locallyEligible:boolean;
 readonly disclaimer:'NO_TELEGRAM_DESTINATION_PROOF';
}
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8640000000000000-120000;
const validTopic=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;
const allowedText=(s:string)=>Array.from(s.replace(
 /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,' ')
 ).slice(0,80).join('');
export function previewForumTopicEducationalSources(s:BotState,p:Policy,
 owner:string,chat:string,thread:number,now:number):
 ForumTopicEducationalSourcePreview|null{
 if(!validTime(now)||!validTopic(thread))return null;
 const topics=localForumTopics(s,p,owner,chat,now);
 const topic=topics?.find(x=>x.threadId===thread);
 if(!topic||!p.canUseChat(s,chat,'navigation')||
  !p.canUseChat(s,chat,'moderation')||
  !p.has(s,owner,'chat.manage',chat,now))return null;
 const mode=forumTopicEducationMode(s,p,chat,thread,now);
 if(!mode)return null;
 const categories=s.educationCategories.filter(c=>c.scope===chat);
 if(categories.length>1_000||s.educationResources.length>30_000)return null;
 const ids=new Set<string>();
 for(const c of categories){
  if(ids.has(c.id))return null;
  ids.add(c.id);
 }
 const available=categories.filter(c=>visibleEducationCategory(s,c,thread));
 const categoryIds=new Set(available.map(c=>c.id));
 const resources=s.educationResources.filter(r=>r.scope===chat&&
  r.status==='PUBLISHED'&&categoryIds.has(r.categoryId));
 const globalIds=new Map<string,number>();
 for(const r of s.educationResources)
  globalIds.set(r.id,(globalIds.get(r.id)??0)+1);
 for(const r of resources)
  if(globalIds.get(r.id)!==1)return null;
 const titles=resources.sort((a,b)=>a.title.localeCompare(b.title)||
  a.id.localeCompare(b.id)).slice(0,8).map(r=>allowedText(r.title));
 return {group:chat,thread,topicTitle:allowedText(topic.title),
  groupVersion:topic.groupVersion,topicPaused:mode==='PAUSED',
  categoryCount:available.length,resourceCount:resources.length,
  titles,epoch:groupMenuEpochDigest(s,chat,thread),ownerAuthorized:true,
  locallyEligible:mode==='INHERIT'&&resources.length>0,
  disclaimer:'NO_TELEGRAM_DESTINATION_PROOF'};
}
