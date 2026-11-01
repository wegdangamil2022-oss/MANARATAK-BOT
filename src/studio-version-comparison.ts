import type {StudioContent,StudioButton} from './button-studio-model.js';
const sameButton=(a:StudioButton,b:StudioButton)=>a.title===b.title&&a.style===b.style&&a.action.kind===b.action.kind&&a.action.target===b.action.target&&
 a.condition.role===b.condition.role&&a.condition.opensAt===b.condition.opensAt&&a.condition.closesAt===b.condition.closesAt&&a.condition.seats===b.condition.seats;
export function studioContentDifferences(before:StudioContent,after:StudioContent):string[]{
 const differences:string[]=[];
 for(const [field,label] of [['name','اسم القالب'],['text','نص الرسالة'],['timezone','المنطقة الزمنية'],['hour12','صيغة الوقت'],['calendar','التقويم']] as const)if(before[field]!==after[field])differences.push('تغيّر '+label);
 if((before.rowsPerPage??8)!==(after.rowsPerPage??8))differences.push('تغيّر عدد صفوف الصفحة');
 if(before.layout.join('-')!==after.layout.join('-'))differences.push('تغيّر توزيع الصفوف');
 const old=new Map(before.buttons.map(b=>[b.id,b])),current=new Map(after.buttons.map(b=>[b.id,b]));
 const added=after.buttons.filter(b=>!old.has(b.id)).length,removed=before.buttons.filter(b=>!current.has(b.id)).length,changed=after.buttons.filter(b=>old.has(b.id)&&!sameButton(old.get(b.id)!,b)).length;
 if(added)differences.push('أزرار أُضيفت: '+added);if(removed)differences.push('أزرار حُذفت: '+removed);if(changed)differences.push('أزرار تغيّرت بياناتها أو شروطها: '+changed);
 if(before.buttons.filter(b=>current.has(b.id)).map(b=>b.id).join(',')!==after.buttons.filter(b=>old.has(b.id)).map(b=>b.id).join(','))differences.push('تغيّر ترتيب الأزرار');
 return differences;
}
const actionNames={URL:'رابط HTTPS',COPY:'نسخ نص',INLINE:'مشاركة Inline',SERVICE:'خدمة تعليمية',MINI_APP:'Mini App (ينتظر الاعتماد)',MENU:'قائمة مترابطة'} as const;
const styleNames={default:'افتراضي',primary:'أزرق',success:'أخضر',danger:'أحمر'} as const;
export function describeStudioContent(content:StudioContent):string{
 const lines=['اسم القالب: '+content.name,'نص الرسالة:',content.text,'المنطقة الزمنية: '+content.timezone,'صيغة الوقت: '+(content.hour12?'12 ساعة':'24 ساعة'),'التقويم: '+(content.calendar==='gregory'?'ميلادي':'هجري'),
  'صفوف الصفحة: '+(content.rowsPerPage??8),'توزيع الصفوف: '+(content.layout.join('-')||'دون أزرار'),'عدد الأزرار: '+content.buttons.length];
 let offset=0;
 for(const [row,size] of content.layout.entries()){
  lines.push('\nالصف '+(row+1));
  for(const [position,button] of content.buttons.slice(offset,offset+size).entries()){
   const c=button.condition;
   lines.push('الزر '+(position+1)+': '+button.title,'النوع: '+actionNames[button.action.kind],'الهدف: '+button.action.target,'النمط: '+styleNames[button.style],
    'الجمهور: '+(c.role==='OWNER'?'المالك':'الجميع'),'موعد الفتح (UTC): '+(c.opensAt?new Date(c.opensAt).toISOString():'دون حد'),'موعد الإغلاق (UTC): '+(c.closesAt?new Date(c.closesAt).toISOString():'دون حد'),'المقاعد: '+(c.seats||'دون حد'));
  }
  offset+=size;
 }
 return lines.join('\n');
}
export function studioComparisonText(before:StudioContent,after:StudioContent,beforeLabel:string,afterLabel:string):string{
 const differences=studioContentDifferences(before,after);
 return 'الفروق من الأولى إلى الثانية:\n'+(differences.length?differences.map(d=>'• '+d).join('\n'):'لا توجد فروق في المحتوى والإعدادات.')+'\n\n'+beforeLabel+'\n'+describeStudioContent(before)+'\n\n'+afterLabel+'\n'+describeStudioContent(after);
}
