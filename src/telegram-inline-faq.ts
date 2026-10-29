import {createHash} from 'node:crypto';
import type {BotStore,BotState,FAQEntry} from './store.js';
import type {Policy} from './policy.js';
import {ApprovedAnswerService} from './education-interactions.js';
import {faqReviewFingerprint} from './faq-review.js';
import {ownerFAQSourceAvailable} from './telegram-owner-faq.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const page='(0|[1-9][0-9]{0,2})';
const list=new RegExp('^of:1:p:'+page+'$','u');
const item=new RegExp('^of:1:([dax]):'+page+':([1-8]):([a-f0-9]{12})$','u');
const answerPage=new RegExp('^of:1:v:'+page+':([1-8]):([a-f0-9]{12}):([0-5])$','u');
const confirmation=/^of:1:c:([A-Za-z0-9_-]{24})$/u;
export function validOwnerFAQInlineRoute(data:string):boolean{
 return typeof data==='string'&&Buffer.byteLength(data)<=64&&
  [list,item,answerPage,confirmation].some(re=>{const m=re.exec(data);return m?.[0]===data;});
}
const b=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const epoch=(s:BotState,p:Policy,q:FAQEntry)=>q.scope==='private'?0:p.chatRevision(s,q.scope);
const proof=(s:BotState,p:Policy,q:FAQEntry)=>createHash('sha256').update(faqReviewFingerprint(s,q)+':'+epoch(s,p,q)).digest('hex').slice(0,12);
const key=(action:string,page:number,slot:number,digest:string)=>'of:1:'+action+':'+page+':'+slot+':'+digest;
const safe=(text:string)=>text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
function entries(s:BotState,p:Policy):FAQEntry[]{
 const counts=new Map<string,number>();for(const q of s.faqEntries)counts.set(q.id,(counts.get(q.id)??0)+1);
 return s.faqEntries.filter(q=>counts.get(q.id)===1&&(q.scope==='private'||p.canUseChat(s,q.scope,'navigation')))
  .sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
}
export async function renderOwnerInlineFAQ(store:BotStore,policy:Policy,actor:string,data:string,clock:()=>number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actor))return null;
 const state=await store.snapshot();
 if(!policy.privateFeature(state,'owner.dashboard',actor))return null;
 const service=new ApprovedAnswerService(store,policy,clock),confirm=confirmation.exec(data);
 if(confirm&&confirm[0]===data){
  const saved=await service.confirmInlineReview(actor,'c_'+confirm[1]);if(!saved)return null;
  return ui('<b>حُفظ قرار الأسئلة الشائعة ✅</b>\nحُدث السجل المحلي وسجل التدقيق.',[[b('↩️ الأسئلة الشائعة','of:1:p:'+saved.returnPage),b('🏠 لوحة المالك','mi:1:h')]]);
 }
 const all=entries(state,policy),pageMatch=list.exec(data);
 if(data==='mi:1:i:10:08'||pageMatch&&pageMatch[0]===data){
  const current=data==='mi:1:i:10:08'?0:Number(pageMatch![1]),pages=Math.max(1,Math.ceil(all.length/8));
  if(current>=pages)return null;
  const rows=all.slice(current*8,current*8+8).map((q,i)=>[b('❓ '+Array.from(q.question).slice(0,50).join(''),key('d',current,i+1,proof(state,policy,q)))]);
  const nav=[];if(current>0)nav.push(b('⬅️ السابق','of:1:p:'+(current-1)));if(current+1<pages)nav.push(b('➡️ التالي','of:1:p:'+(current+1)));if(nav.length)rows.push(nav);
  rows.push([b('↩️ التعليم والمكتبة','mi:1:s:10:0'),b('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>مراجعة الأسئلة الشائعة 🧠</b>\nالسجلات المتاحة: '+all.length+'\nصفحة '+(current+1)+' من '+pages+'\nاختر سؤالًا لمراجعة الإجابة ومصدرها.',rows);
 }
 const answer=answerPage.exec(data);
 const selected=answer&&answer[0]===data?['','d',answer[1]!,answer[2]!,answer[3]!] :item.exec(data);
 if(!selected||!answer&&selected[0]!==data)return null;
 const current=Number(selected[2]),slot=Number(selected[3]),q=all[current*8+slot-1];
 if(!q||proof(state,policy,q)!==selected[4])return null;
 const sourceAvailable=ownerFAQSourceAvailable(state,q);
 const approve=q.status==='DRAFT'&&sourceAvailable,archive=q.status==='APPROVED';
 const back=[b('↩️ صفحة الأسئلة','of:1:p:'+current),b('🏠 لوحة المالك','mi:1:h')];
 const chars=Array.from(q.answer),answerIndex=answer?Number(answer[4]):0,answerPages=Math.max(1,Math.ceil(chars.length/200));
 if(answerIndex>=answerPages)return null;
 const text='<b>مراجعة الإجابة ومصدرها 📋</b>\nالسؤال: '+safe(q.question)+'\nالإجابة ('+(answerIndex+1)+' من '+answerPages+'): '+safe(chars.slice(answerIndex*200,answerIndex*200+200).join(''))+'\nالنطاق: '+safe(q.scope)+'\nالحالة: '+q.status+'\nالمصدر: <code>'+safe(q.sourceResourceId)+'</code>\nالمصدر المنشور متاح: '+(sourceAvailable?'نعم':'لا');
 const answerNav=[];if(answerIndex>0)answerNav.push(b('⬅️ نص الإجابة السابق',key('v',current,slot,selected[4]!)+':'+(answerIndex-1)));if(answerIndex+1<answerPages)answerNav.push(b('➡️ بقية الإجابة',key('v',current,slot,selected[4]!)+':'+(answerIndex+1)));
 if(selected[1]==='d')return ui(text,[...(answerNav.length?[answerNav]:[]),...(approve?[[b('🧾 معاينة اعتماد الإجابة',key('a',current,slot,selected[4]!))]]:[]),...(archive?[[b('🗃️ معاينة أرشفة الإجابة',key('x',current,slot,selected[4]!))]]:[]),back]);
 if(selected[1]==='a'?!approve:!archive)return null;
 try{
  const ref=await service.issueInlineReview(actor,q.id,selected[1]==='a'?'APPROVED':'ARCHIVED',faqReviewFingerprint(state,q),epoch(state,policy,q),current);
  return ui(text+'\n\nالقرار: '+(selected[1]==='a'?'اعتماد الإجابة':'أرشفة الإجابة')+'\nالتأكيد صالح لدقيقتين ولمرة واحدة.',[[b('✅ تأكيد القرار','of:1:c:'+ref.slice(2))],[b('↩️ إلغاء والعودة',key('d',current,slot,selected[4]!))],back]);
 }catch{return null;}
}
