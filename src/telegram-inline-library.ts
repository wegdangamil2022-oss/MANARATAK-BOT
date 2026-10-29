import {createHash} from 'node:crypto';
import type {BotStore,BotState,EducationResource} from './store.js';
import type {Policy} from './policy.js';
import {EducationService} from './education.js';
import {resourceArchiveFingerprint} from './education-archive.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const page='(0|[1-9][0-9]{0,2})';
const list=new RegExp('^ol:1:p:'+page+'$','u');
const item=new RegExp('^ol:1:([da]):'+page+':([1-8]):([a-f0-9]{12})$','u');
const confirmation=/^ol:1:c:([A-Za-z0-9_-]{24})$/u;
export function validOwnerLibraryInlineRoute(data:string):boolean{
 return typeof data==='string'&&Buffer.byteLength(data)<=64&&[list,item,confirmation].some(re=>{const m=re.exec(data);return m?.[0]===data;});
}
const b=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const epoch=(s:BotState,p:Policy,r:EducationResource)=>r.scope==='private'?0:p.chatRevision(s,r.scope);
const proof=(s:BotState,p:Policy,r:EducationResource)=>createHash('sha256').update(resourceArchiveFingerprint(r)+':'+epoch(s,p,r)).digest('hex').slice(0,12);
const key=(action:string,page:number,slot:number,digest:string)=>'ol:1:'+action+':'+page+':'+slot+':'+digest;
const safe=(text:string)=>Array.from(text).slice(0,500).join('').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
function entries(s:BotState,p:Policy):EducationResource[]{
 const counts=new Map<string,number>();for(const r of s.educationResources)counts.set(r.id,(counts.get(r.id)??0)+1);
 return s.educationResources.filter(r=>counts.get(r.id)===1&&r.status==='PUBLISHED'&&(r.scope==='private'||p.canUseChat(s,r.scope,'navigation')))
  .sort((a,b)=>a.title.localeCompare(b.title,'ar')||a.id.localeCompare(b.id));
}
export async function renderOwnerInlineLibrary(store:BotStore,policy:Policy,actor:string,data:string,clock:()=>number):Promise<OwnerInlineScreen|null>{
 if(!policy.isOwner(actor))return null;
 const state=await store.snapshot();if(!policy.privateFeature(state,'owner.dashboard',actor))return null;
 const service=new EducationService(store,policy,clock),confirm=confirmation.exec(data);
 if(confirm&&confirm[0]===data){
  const saved=await service.confirmInlineArchive(actor,'c_'+confirm[1]);if(!saved)return null;
  const current=await store.snapshot(),returnPage=Math.min(saved.returnPage,Math.max(0,Math.ceil(entries(current,policy).length/8)-1));
  return ui('<b>أُرشف المورد ✅</b>\nحُدثت المكتبة المحلية وسجل التدقيق.',[[b('↩️ المكتبة','ol:1:p:'+returnPage),b('🏠 لوحة المالك','mi:1:h')]]);
 }
 const all=entries(state,policy),pageMatch=list.exec(data);
 if(data==='mi:1:i:10:09'||pageMatch&&pageMatch[0]===data){
  const current=data==='mi:1:i:10:09'?0:Number(pageMatch![1]),pages=Math.max(1,Math.ceil(all.length/8));if(current>=pages)return null;
  const rows=all.slice(current*8,current*8+8).map((r,i)=>[b('📚 '+Array.from(r.title).slice(0,50).join(''),key('d',current,i+1,proof(state,policy,r)))]);
  const nav=[];if(current>0)nav.push(b('⬅️ السابق','ol:1:p:'+(current-1)));if(current+1<pages)nav.push(b('➡️ التالي','ol:1:p:'+(current+1)));if(nav.length)rows.push(nav);
  rows.push([b('↩️ التعليم والمكتبة','mi:1:s:10:0'),b('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>إدارة المكتبة 📚</b>\nالموارد المنشورة المتاحة: '+all.length+'\nصفحة '+(current+1)+' من '+pages,rows);
 }
 const selected=item.exec(data);if(!selected||selected[0]!==data)return null;
 const current=Number(selected[2]),slot=Number(selected[3]),r=all[current*8+slot-1];if(!r||proof(state,policy,r)!==selected[4])return null;
 const back=[b('↩️ صفحة المكتبة','ol:1:p:'+current),b('🏠 لوحة المالك','mi:1:h')];
 const text='<b>مراجعة المورد 📋</b>\nالعنوان: '+safe(r.title)+'\nالجامعة: '+safe(r.university)+'\nالتصنيف: '+safe(r.categoryId)+'\nالنطاق: '+safe(r.scope)+'\nالمعرف: <code>'+safe(r.id)+'</code>';
 if(selected[1]==='d')return ui(text,[[b('🗃️ معاينة الأرشفة',key('a',current,slot,selected[4]!))],back]);
 try{
  const ref=await service.issueInlineArchive(actor,r.id,resourceArchiveFingerprint(r),epoch(state,policy,r),current);
  return ui(text+'\n\nستُؤرشف هذه النسخة من المورد. التأكيد صالح لدقيقتين ولمرة واحدة.',[[b('✅ تأكيد الأرشفة','ol:1:c:'+ref.slice(2))],[b('↩️ إلغاء والعودة',key('d',current,slot,selected[4]!))],back]);
 }catch{return null;}
}
