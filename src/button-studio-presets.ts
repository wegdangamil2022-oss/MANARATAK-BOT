import type {StudioContent} from './button-studio-model.js';
/** Versioned starter drafts only; importing never approves or publishes content. */
export const studioPresets=[
 {id:'education',name:'خدمات الطالب',version:1,text:'اختر الخدمة التعليمية المطلوبة.',buttons:[
  {title:'🎓 المنح الدراسية',target:'si:2:s:h'},
  {title:'🏛️ الجامعات والتخصصات',target:'si:2:u:h'},
  {title:'📝 الاختبارات',target:'si:2:e:h'},
  {title:'📚 الدورات',target:'si:2:c:h'},
  {title:'📂 الملفات والنماذج',target:'si:2:f:h'}]},
 {id:'welcome',name:'رسالة ترحيب',version:1,text:'مرحبًا {العضو} في {اسم_المجموعة}.\nالتاريخ: {التاريخ}\nالقوانين: {رابط_القوانين}',buttons:[
  {title:'🎓 مكتبة الطالب',target:'student:open'}]}
] as const;
export function studioPresetContent(key:string,newId:()=>string):StudioContent|null{
 const p=studioPresets.find(p=>p.id===key);if(!p)return null;
 return {name:p.name+' · نموذج '+p.version,text:p.text,timezone:'Asia/Aden',hour12:false,calendar:'gregory',
  buttons:p.buttons.map(b=>({id:newId(),title:b.title,action:{kind:'SERVICE',target:b.target},style:'primary',condition:{role:'ANY',opensAt:0,closesAt:0,seats:0}})),layout:p.buttons.map(()=>1)};
}
