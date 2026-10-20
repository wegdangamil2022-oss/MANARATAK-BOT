import type {EducationCategory,EducationResource} from './store.js';

/** Exactly the Telegram reply keyboard surface. No callback data, URLs,
 * contact/location request, permissions or admin actor information allowed.
 * Buttons send plain Telegram text; the inbound handler ALWAYS re-authorizes.
 */
export interface TelegramReplyKeyboard {
 readonly keyboard:readonly (readonly {readonly text:string}[])[];
 readonly resize_keyboard:true;
 readonly is_persistent:true;
}
const keyboard=(rows:readonly (readonly string[])[]):TelegramReplyKeyboard=>({
 keyboard:rows.map(row=>row.map(text=>({text}))),
 resize_keyboard:true,is_persistent:true
});
export const menuLabels={
 scholarships:'🎓 المنح الدراسية',
 courses:'📚 الدورات التعليمية',
 universities:'🏛 الجامعات والتخصصات',
 exams:'📝 الاختبارات',
 library:'📂 التعليم والموارد',
 files:'📄 الملفات والنماذج',
 assistant:'💬 المساعد التعليمي',
 communities:'👥 المجموعات والقنوات',
 help:'🆘 الدعم والمساعدة',
 owner:'🔐 لوحة المالك',
 home:'🏠 الرئيسية',
 back:'↩️ رجوع'
} as const;
export function mainMenuKeyboard(owner:boolean):TelegramReplyKeyboard{
 const m=menuLabels;
 const rows:string[][]=[
  [m.scholarships,m.courses],
  [m.universities,m.exams],
  [m.library,m.files],
  [m.assistant,m.communities],
  [m.help]
 ];
 if(owner)rows[4]!.push(m.owner);
 return keyboard(rows);
}
export function backMenuKeyboard():TelegramReplyKeyboard{
 return keyboard([[menuLabels.back,menuLabels.home]]);
}
const trimTitle=(title:string,max:number):string=>title
 .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ')
 .trim().slice(0,Math.max(1,max));
/** Stable category/resource token travels in Telegram-sent text. It is never
 * an authorization grant; the application must compare the exact label to
 * the currently visible entity before returning private content.
 */
export function categoryButton(category:EducationCategory):string{
 return '📁 '+trimTitle(category.title,Math.max(1,74-category.id.length))+' · '+category.id;
}
export function resourceButton(resource:Pick<EducationResource,'id'|'title'>):string{
 return '🔎 '+trimTitle(resource.title,Math.max(1,74-resource.id.length))+' · '+resource.id;
}
/** A page marker is only an untrusted navigation *request*, never a grant
 * or a durable cursor. Every selection must rerun the library's auth checks.
 */
export type MenuPageCommand={kind:'c'|'r';id:string;page:number;direction:'next'|'previous'};
const sectionSet=new Set(['all','scholarships','courses','universities','exams','files']);
export function menuPageButton(kind:'c'|'r',id:string,page:number,direction:'next'|'previous'):string{
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||
   (kind==='c'&&!sectionSet.has(id))||
   !Number.isInteger(page)||page<0||page>999)throw Error('INVALID_MENU_PAGE');
 return (direction==='next'?'➡️ التالي':'⬅️ السابق')+' · '+kind+':'+id+':'+page;
}
export function parseMenuPageCommand(text:string):MenuPageCommand|null{
 if(typeof text!=='string'||text.length>110)return null;
 const found=/^(➡️ التالي|⬅️ السابق) · ([cr]):([A-Za-z0-9_-]{1,64}):(0|[1-9][0-9]{0,2})$/u.exec(text);
 if(!found||found[0]!==text)return null;
 const kind=found[2]! as 'c'|'r',id=found[3]!,page=Number(found[4]!);
 if(kind==='c'&&!sectionSet.has(id))return null;
 const direction=found[1]==='➡️ التالي'?'next':'previous';
 return {kind,id,page,direction};
}
export function listingKeyboard(buttons:readonly string[],pageControls:{
 previous?:string;next?:string
}={}):TelegramReplyKeyboard{
 const rows:string[][]=[];
 for(let i=0;i<Math.min(buttons.length,10);i+=2)
  rows.push(buttons.slice(i,i+2));
 const paging=[pageControls.previous,pageControls.next].filter((x):x is string=>Boolean(x));
 if(paging.length)rows.push(paging);
 rows.push([menuLabels.back,menuLabels.home]);
 return keyboard(rows);
}
export function categoryButtonId(input:string):string|null{
 const m=/^📁 .+ · ([a-zA-Z0-9_-]{1,64})$/u.exec(input);
 return m?.[1]??null;
}
export function resourceButtonId(input:string):string|null{
 const m=/^🔎 .+ · ([a-zA-Z0-9_-]{1,64})$/u.exec(input);
 return m?.[1]??null;
}
const tags:Readonly<Record<string,RegExp>>={
 scholarships:/منح|ابتعاث|scholar|grant|funding/iu,
 courses:/دور|تدريب|course|training/iu,
 universities:/جامع|تخصص|univers|major|college/iu,
 exams:/اختبار|امتحان|exam|test|ielts|csca|toefl/iu,
 files:/ملف|نموذج|ملفات|وثائق|دليل|file|template|form/iu
};
export function matchingCategories(categories:readonly EducationCategory[],
 section:string):EducationCategory[]{
 const re=tags[section];
 return re?categories.filter(x=>re.test(x.title)||re.test(x.id)):[...categories];
}
export function isValidTelegramReplyKeyboard(value:unknown):value is TelegramReplyKeyboard{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const m=value as Record<string,unknown>;
 if(Object.keys(m).length!==3||m.resize_keyboard!==true||m.is_persistent!==true||
   !Array.isArray(m.keyboard)||m.keyboard.length<1||m.keyboard.length>12)return false;
 return m.keyboard.every(row=>Array.isArray(row)&&row.length>=1&&row.length<=2&&
  row.every(button=>{
   if(!button||typeof button!=='object'||Array.isArray(button))return false;
   const b=button as Record<string,unknown>;
   return Object.keys(b).length===1&&typeof b.text==='string'&&b.text.trim()!==''&&
    Array.from(b.text).length<=96&&Buffer.byteLength(b.text,'utf8')<=256&&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(b.text);
  }));
}
