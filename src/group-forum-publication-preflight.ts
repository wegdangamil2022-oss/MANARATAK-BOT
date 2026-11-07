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
 readonly approvedForBroadcastCount:number;
 readonly page:number;readonly pages:number;
 readonly titles:readonly string[];
 readonly sources:readonly {id:string;title:string;approvedForBroadcast:boolean}[];
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
 owner:string,chat:string,thread:number,now:number,page=0):
 ForumTopicEducationalSourcePreview|null{
 if(!validTime(now)||!validTopic(thread)||!Number.isSafeInteger(page)||
  page<0||page>999)return null;
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
 const approvedForBroadcast=(r:typeof resources[number])=>
  typeof r.publicationText==='string'&&
  r.publicationText.trim().length>=4&&
  typeof r.publicationTextReviewedBy==='string'&&
  /^[1-9][0-9]{0,15}$/u.test(r.publicationTextReviewedBy);
 const pages=Math.max(1,Math.ceil(resources.length/8));
 if(page>=pages)return null;
 const selected=resources.sort((a,b)=>a.title.localeCompare(b.title)||
  a.id.localeCompare(b.id)).slice(page*8,(page+1)*8);
 const titles=selected.map(r=>allowedText(r.title));
 const sources=selected.map(r=>({id:r.id,title:allowedText(r.title),
  approvedForBroadcast:approvedForBroadcast(r)}));
 return {group:chat,thread,topicTitle:allowedText(topic.title),
  groupVersion:topic.groupVersion,topicPaused:mode==='PAUSED',
  categoryCount:available.length,resourceCount:resources.length,
  approvedForBroadcastCount:resources.filter(approvedForBroadcast).length,
  titles,sources,page,pages,
  epoch:groupMenuEpochDigest(s,chat,thread),ownerAuthorized:true,
  locallyEligible:mode==='INHERIT'&&resources.length>0,
  disclaimer:'NO_TELEGRAM_DESTINATION_PROOF'};
}
