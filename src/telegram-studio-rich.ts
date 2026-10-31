import {studioURL} from './button-studio-model.js';
import {validStudioInlineRoute} from './telegram-inline-studio.js';
export type StudioNativeButton={text:string;style?:'primary'|'success'|'danger'}&({callback_data:string}|{url:string}|{copy_text:{text:string}}|{switch_inline_query:string});
export interface StudioNativeKeyboard{inline_keyboard:StudioNativeButton[][];}
export function validStudioNativeKeyboard(v:unknown):v is StudioNativeKeyboard{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==1)return false;
 const rows=(v as Record<string,unknown>).inline_keyboard;if(!Array.isArray(rows)||rows.length<1||rows.length>30)return false;let count=0;
 for(const row of rows){if(!Array.isArray(row)||row.length<1||row.length>8)return false;count+=row.length;
  for(const b of row){if(!b||typeof b!=='object'||Array.isArray(b)||typeof b.text!=='string'||Array.from(b.text).length<1||Array.from(b.text).length>96||Buffer.byteLength(b.text)>256||/[\u0000-\u001f\u007f]/u.test(b.text))return false;
   const keys=Object.keys(b),types=keys.filter(k=>['callback_data','url','copy_text','switch_inline_query'].includes(k));
   if(types.length!==1||keys.some(k=>!['text','style',...types].includes(k))||b.style!==undefined&&!['primary','success','danger'].includes(b.style))return false;
   if('callback_data' in b&&(typeof b.callback_data!=='string'||!validStudioInlineRoute(b.callback_data)&&!/^mi:1:(?:h|s:07:[01])$/u.test(b.callback_data)))return false;
   if('url' in b&&(typeof b.url!=='string'||!studioURL(b.url)))return false;
   if('copy_text' in b&&(!b.copy_text||typeof b.copy_text!=='object'||Array.isArray(b.copy_text)||Object.keys(b.copy_text).length!==1||typeof b.copy_text.text!=='string'||Array.from(b.copy_text.text).length<1||Array.from(b.copy_text.text).length>256||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(b.copy_text.text)))return false;
   if('switch_inline_query' in b&&(typeof b.switch_inline_query!=='string'||Array.from(b.switch_inline_query).length>128||/[\u0000-\u001f\u007f]/u.test(b.switch_inline_query)))return false;
  }
 }
 return count<=64;
}
