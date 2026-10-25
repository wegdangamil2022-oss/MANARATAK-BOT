import {createHash} from 'node:crypto';
import type {BotStore,BotState,EducationCategory,EducationResource} from './store.js';
import type {Policy} from './policy.js';
import {publicEducationResource} from './education.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';

/** Student's reviewed PRIVATE library only.
 * Selectors are weak fingerprints for stale-page detection, not permissions.
 * Every tap opens a fresh atomic snapshot and rechecks the current feature,
 * category ancestors and PUBLISHED state before projecting public-only fields.
 * Never grant administrative capabilities through student callback_data.
 */
export type StudentInlineRoute={kind:'categories';page:number}|
 {kind:'resources';catPage:number;slot:number;categoryDigest:string;page:number}|
 {kind:'detail';catPage:number;slot:number;categoryDigest:string;page:number;
 resourceSlot:number;resourceDigest:string};
const page='(0|[1-9][0-9]{0,2})';
const slot='([1-8])',digest='([a-f0-9]{12})';
const pRe=new RegExp('^si:1:p:'+page+'$','u');
const cRe=new RegExp('^si:1:c:'+page+':'+slot+':'+digest+'$','u');
const lRe=new RegExp('^si:1:l:'+page+':'+slot+':'+digest+':'+page+'$','u');
const rRe=new RegExp('^si:1:r:'+page+':'+slot+':'+digest+':'+page+':'+slot+':'+digest+'$','u');
export function studentInlineRoute(data:string):StudentInlineRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='si:1:h')return {kind:'categories',page:0};
 const p=pRe.exec(data);
 if(p&&p[0]===data)return {kind:'categories',page:Number(p[1])};
 const c=cRe.exec(data);
 if(c&&c[0]===data)return {kind:'resources',catPage:Number(c[1]),
   slot:Number(c[2]),categoryDigest:c[3]!,page:0};
 const l=lRe.exec(data);
 if(l&&l[0]===data)return {kind:'resources',catPage:Number(l[1]),
   slot:Number(l[2]),categoryDigest:l[3]!,page:Number(l[4])};
 const r=rRe.exec(data);
 if(r&&r[0]===data)return {kind:'detail',catPage:Number(r[1]),
   slot:Number(r[2]),categoryDigest:r[3]!,page:Number(r[4]),
   resourceSlot:Number(r[5]),resourceDigest:r[6]!};
 return null;
}
type Button={readonly text:string;readonly callback_data:string};
const button=(text:string,callback_data:string):Button=>({text,callback_data});
const keyboard=(rows:readonly (readonly Button[])[]):TelegramInlineKeyboard=>({inline_keyboard:rows});
const html=(v:string):string=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const brief=(v:string):string=>{
 const normalized=v.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim();
 let str='',bytes=0,chars=0;
 for(const cp of normalized){const n=Buffer.byteLength(cp,'utf8');
  if(chars>=65||bytes+n>205)break;
  str+=cp;bytes+=n;chars++;
 }
 return str.trim()||'—';
};
const hash=(data:unknown):string=>createHash('sha256').update(
 'MANARATAK:STUDENT:INLINE:V1:').update(JSON.stringify(data)).digest('hex').slice(0,12);
const categoryProof=(c:EducationCategory)=>hash([c.id,c.scope,c.title,c.order,c.parentId,c.enabled,c.revision??0]);
const resourceProof=(r:EducationResource)=>hash([r.id,r.categoryId,r.scope,r.title,
 r.university,r.cycle,r.degree,r.seats,r.status]);
const PAGE_SIZE=8;
const pageKey=(p:number)=>'si:1:p:'+p;
const categoryKey=(p:number,slot:number,digest:string)=>'si:1:c:'+p+':'+slot+':'+digest;
const listKey=(p:number,slot:number,digest:string,rp:number)=>
 'si:1:l:'+p+':'+slot+':'+digest+':'+rp;
const resourceKey=(p:number,slot:number,cd:string,rp:number,i:number,rd:string)=>
 'si:1:r:'+p+':'+slot+':'+cd+':'+rp+':'+i+':'+rd;
/** Same fail-closed parent visibility rules as EducationService, plus a cycle
 * guard to prevent corrupted parent references from hanging the bot.
 */
function visible(c:EducationCategory,s:BotState):boolean{
 const seen=new Set<string>();let next:EducationCategory|undefined=c;
 while(next){
  if(!next.enabled||seen.has(next.id))return false;
  seen.add(next.id);
  if(next.parentId===null)return true;
  next=s.educationCategories.find(x=>x.scope===c.scope&&x.id===next!.parentId);
 }
 return false;
}
const categories=(s:BotState)=>s.educationCategories
 .filter(c=>c.scope==='private'&&visible(c,s))
 .sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
const resources=(s:BotState,c:EducationCategory)=>s.educationResources
 .filter(r=>r.scope==='private'&&r.categoryId===c.id&&r.status==='PUBLISHED');
const screen=(text:string,rows:readonly (readonly Button[])[]):OwnerInlineScreen=>({
 text,keyboard:keyboard(rows)
});
function home(s:BotState,page:number):OwnerInlineScreen|null{
 const all=categories(s),pages=Math.max(1,Math.ceil(all.length/PAGE_SIZE));
 if(page>=pages)return null;
 const cur=all.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
 const rows:Button[][]=[];
 for(let i=0;i<cur.length;i+=2){
  rows.push(cur.slice(i,i+2).map((c,j)=>
   button('📚 '+brief(c.title),categoryKey(page,i+j+1,categoryProof(c)))));
 }
 const nav:Button[]=[];
 if(page>0)nav.push(button('⬅️ السابق',pageKey(page-1)));
 if(page+1<pages)nav.push(button('➡️ التالي',pageKey(page+1)));
 if(nav.length)rows.push(nav);
 rows.push([button('🏠 المكتبة','si:1:h')]);
 return screen('<b>مكتبة الطالب — منارتك 🎓</b>\n'
  +'الأقسام المتاحة: '+all.length+'\n'
  +(all.length?'صفحة '+(page+1)+' من '+pages+'\n':'لا توجد أقسام معتمدة حاليًا.\n')
  +'تظهر الأقسام المفعلة والموارد المنشورة محليًا فقط. '
  +'لا يشير ذلك إلى اتصال حي ببيانات المنصّة أو قبول جامعي.',rows);
}
export async function renderStudentInline(store:BotStore,policy:Policy,actorId:string,
 data:string):Promise<OwnerInlineScreen|null>{
 if(!/^[1-9][0-9]{0,19}$/u.test(actorId))return null;
 const route=data==='student:open'?{kind:'categories' as const,page:0}:studentInlineRoute(data);
 if(!route)return null;
 const s=await store.snapshot();
 if(!policy.privateFeature(s,'education.navigate',actorId))return null;
 if(route.kind==='categories')return home(s,route.page);
 const all=categories(s),cat=all[route.catPage*PAGE_SIZE+route.slot-1];
 if(!cat||route.slot>Math.min(PAGE_SIZE,all.length-route.catPage*PAGE_SIZE)||
  categoryProof(cat)!==route.categoryDigest)return null;
 const allResources=resources(s,cat);
 const pages=Math.max(1,Math.ceil(allResources.length/PAGE_SIZE));
 if(route.page>=pages)return null;
 if(route.kind==='resources'){
  const cur=allResources.slice(route.page*PAGE_SIZE,(route.page+1)*PAGE_SIZE);
  const rows:Button[][]=[];
  for(let i=0;i<cur.length;i+=2)rows.push(cur.slice(i,i+2).map((r,j)=>
    button('📄 '+brief(r.title),resourceKey(route.catPage,route.slot,
      route.categoryDigest,route.page,i+j+1,resourceProof(r)))));
  const nav:Button[]=[];
  if(route.page>0)nav.push(button('⬅️ السابق',listKey(route.catPage,route.slot,
   route.categoryDigest,route.page-1)));
  if(route.page+1<pages)nav.push(button('➡️ التالي',listKey(route.catPage,route.slot,
   route.categoryDigest,route.page+1)));
  if(nav.length)rows.push(nav);
  rows.push([button('↩️ الأقسام',pageKey(route.catPage)),button('🏠 المكتبة','si:1:h')]);
  return screen('<b>'+html(cat.title)+'</b>\n'
   +'الموارد المنشورة: '+allResources.length+'\n'
   +(allResources.length?'صفحة '+(route.page+1)+' من '+pages+'\n':
    'لا توجد موارد منشورة في هذا القسم حاليًا.\n')
   +'هذه موارد راجعها مالك المكتبة ونُشرت محليًا.',rows);
 }
 const resource=allResources[route.page*PAGE_SIZE+route.resourceSlot-1];
 if(!resource||route.resourceSlot>Math.min(PAGE_SIZE,allResources.length-route.page*PAGE_SIZE)||
  resourceProof(resource)!==route.resourceDigest)return null;
 const publicResource=publicEducationResource(resource);
 return screen('<b>مورد تعليمي منشور 📄</b>\n'
  +'العنوان: '+html(publicResource.title)+'\n'
  +'الجامعة: '+html(publicResource.university)+'\n'
  +'الدورة: '+html(publicResource.cycle)+'\n'
  +'الدرجة: '+html(publicResource.degree)+'\n'
  +(publicResource.seats===null?'':'المقاعد: '+publicResource.seats+'\n')
  +'بيانات المكتبة المحلية فقط؛ راجع دائمًا المصدر الرسمي قبل التقديم.',
  [[button('↩️ موارد القسم',listKey(route.catPage,route.slot,route.categoryDigest,route.page)),
    button('🏠 المكتبة','si:1:h')]]);
}
