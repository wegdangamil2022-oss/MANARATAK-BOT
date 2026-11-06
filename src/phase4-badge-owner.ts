import {Phase4BadgesService} from './phase4-badges.js';
import {BADGE_LABELS,isBadgeCode,type BadgeCode} from './phase4-badge-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
const ID='[a-f0-9]{24}';
const ROUTE=new RegExp('^bg:1:(?:h|p:[0-3]|v:'+ID+'|[akr]:'+ID+':[123])$','u');
export const validBadgeOwnerRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v);
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const back=btn('↩️ التفاعل والترحيب','mi:1:s:09:1');
const home=btn('🏅 الشارات والتقدير','bg:1:h');
export type BadgeOwnerCommand={kind:'LIST'}|{kind:'CREATE';
 chatId:string;memberId:string;code:BadgeCode};
export function parseBadgeOwnerCommand(input:string):BadgeOwnerCommand|null{
 if(input==='/badges')return {kind:'LIST'};
 if(typeof input!=='string'||input.length>115)return null;
 const m=/^\/badgedraft (-[1-9][0-9]{0,15}) ([1-9][0-9]{0,15}) ([A-Z_]{3,30})$/u.exec(input);
 if(!m||!Number.isSafeInteger(Number(m[1]))||
  !Number.isSafeInteger(Number(m[2]))||!isBadgeCode(m[3]))return null;
 return {kind:'CREATE',chatId:m[1]!,memberId:m[2]!,code:m[3]};
}
async function detail(service:Phase4BadgesService,actor:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const b=await service.ownerView(actor,id);if(!b)return null;
 const rows:{text:string;callback_data:string}[][]=[];
 if(b.status==='DRAFT')rows.push([btn('✅ اعتماد الشارة بعد المراجعة','bg:1:a:'+id+':1')]);
 if(b.status==='AWARDED')rows.push([btn('⚠️ مراجعة سحب الشارة','bg:1:k:'+id+':2')]);
 rows.push([home],[back]);
 return ui('<b>🏅 الشارات والتقدير — 09:12</b>\n'+
  'المجموعة: <code>'+b.chatId+'</code>\n'+
  'الحساب الذي وافق على الشارات: <code>'+b.memberId+'</code>\n'+
  'نوع التقدير: '+BADGE_LABELS[b.code]+'\n'+
  'حالة مراجعة المالك: '+b.status+'\n'+
  'معرّف المسودة: <code>'+b.id+'</code>\n'+
  'هذه شهادة تقدير اجتماعي محلية، وليست اعتمادًا أكاديميًا أو شهادة إنجاز أو صلاحية إدارة.\n'+
  'لا ترسل الموافقة أي إعلان أو رسالة جماعية، ولا يتم ترتيب الطلاب علنًا.',
  rows);
}
async function listing(service:Phase4BadgesService,actor:string,page=0):
 Promise<OwnerInlineScreen|null>{
 const all=await service.list(actor),pages=Math.max(1,Math.ceil(all.length/10));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows=all.slice(page*10,page*10+10).map(x=>[btn(
  (x.status==='DRAFT'?'📝 ':x.status==='AWARDED'?'🏅 ':'🔒 ')+
  BADGE_LABELS[x.code]+' · '+x.memberId.slice(-4),'bg:1:v:'+x.id)]);
 if(pages>1){
  const nav:{text:string;callback_data:string}[]=[];
  if(page>0)nav.push(btn('⬅️ السابق','bg:1:p:'+(page-1)));
  if(page+1<pages)nav.push(btn('التالي ➡️','bg:1:p:'+(page+1)));
  if(nav.length)rows.push(nav);
 }
 rows.push([back]);
 return ui('<b>🏅 الشارات والتقدير — 09:12</b>\n'+
  'الشارات اختيارية، ولا تُمنح إلا للعضو الذي فعّل موافقته من الخاص:\n'+
  '<code>/badgeon GROUP_ID</code>\n'+
  'بعد التأكد من مساهمته التعليمية، ينشئ المالك مسودة ثم يراجعها:\n'+
  '<code>/badgedraft -1001234 200 STUDY_SUPPORT</code>\n'+
  'أنواع التقدير:\n'+
  '◆ HELPFULNESS — مساعدة تعليمية\n'+
  '◆ STUDY_SUPPORT — دعم المذاكرة\n'+
  '◆ RESOURCE_GUIDE — مشاركة مصادر تعليمية\n'+
  '◆ COMMUNITY_CARE — مساهمة إيجابية\n'+
  'يمكن للعضو سحب الموافقة ومحو شاراته من الخاص. لا لوائح متصدرين ولا درجات قبول منح ولا رتبة إدارية.\n'+
  'صفحة '+(page+1)+' من '+pages+' · السجلات '+all.length,rows);
}
export async function badgeOwnerScreen(
 service:Phase4BadgesService,actor:string,input:string
):Promise<OwnerInlineScreen|null>{
 try{
  await service.expire();
  const parsed=parseBadgeOwnerCommand(input);
  if(parsed?.kind==='CREATE'){
   const b=await service.draft(actor,parsed.chatId,parsed.memberId,parsed.code);
   return detail(service,actor,b.id);
  }
  if(parsed?.kind==='LIST'||input==='mi:1:i:09:12'||input==='bg:1:h')
   return listing(service,actor);
  if(!validBadgeOwnerRoute(input))return null;
  const page=/^bg:1:p:([0-3])$/u.exec(input);
  if(page)return listing(service,actor,Number(page[1]));
  const view=/^bg:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(service,actor,view[1]!);
  const approve=/^bg:1:a:([a-f0-9]{24}):([123])$/u.exec(input);
  if(approve){
   if(!await service.approve(actor,approve[1]!,Number(approve[2])))return null;
   return detail(service,actor,approve[1]!);
  }
  const review=/^bg:1:k:([a-f0-9]{24}):([123])$/u.exec(input);
  if(review){
   const b=await service.ownerView(actor,review[1]!);
   if(!b||b.status!=='AWARDED'||b.revision!==Number(review[2]))return null;
   return ui('<b>⚠️ مراجعة سحب شارة التقدير</b>\n'+
    'النوع: '+BADGE_LABELS[b.code]+'\n'+
    'الحساب: <code>'+b.memberId+'</code>\n'+
    'سيُسحب تقدير هذا الحساب محليًا، دون رسالة أو إعلان جماعي.',
    [[btn('🔒 نعم، اسحب الشارة','bg:1:r:'+b.id+':2')],
     [btn('↩️ تراجع','bg:1:v:'+b.id)]]);
  }
  const revoke=/^bg:1:r:([a-f0-9]{24}):([123])$/u.exec(input);
  if(revoke){
   if(!await service.revoke(actor,revoke[1]!,Number(revoke[2])))return null;
   return detail(service,actor,revoke[1]!);
  }
  return null;
 }catch{return null;}
}
