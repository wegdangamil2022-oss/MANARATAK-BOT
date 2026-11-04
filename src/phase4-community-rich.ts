/** Opt-in Telegram-only photo and URL buttons for community greetings.
 * Never fetch arbitrary URLs or interpret buttons as callback authorization.
 */
export interface CommunityLinkButton{text:string;url:string}
export interface CommunityLinkKeyboard{
 inline_keyboard:CommunityLinkButton[][];
}
export function validCommunityPhotoId(v:unknown):v is string{
 return typeof v==='string'&&/^[A-Za-z0-9_-]{25,200}$/u.test(v);
}
/** Strict canonical HTTPS links. URL parsing is for validation ONLY; no network. */
export function validCommunityLinkUrl(v:unknown):v is string{
 if(typeof v!=='string'||v.length<15||v.length>512||
  /[\s\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v))return false;
 try{
  const url=new URL(v);
  return url.protocol==='https:'&&url.href===v&&!url.username&&!url.password&&
   !url.port&&!url.search&&!url.hash&&url.hostname!=='localhost'&&
   !url.hostname.split('.').some(label=>label.startsWith('xn--'))&&
   /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u.test(url.hostname);
 }catch{return false;}
}
export function validCommunityLinkButton(value:unknown):value is CommunityLinkButton{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const button=value as Record<string,unknown>;
 return Object.keys(button).length===2&&Object.keys(button).every(k=>k==='text'||k==='url')&&
  typeof button.text==='string'&&Array.from(button.text.trim()).length>=1&&
  Array.from(button.text).length<=48&&Buffer.byteLength(button.text,'utf8')<=160&&
  !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(button.text)&&
  validCommunityLinkUrl(button.url);
}
export function validCommunityLinkButtons(v:unknown):v is CommunityLinkButton[]{
 if(!Array.isArray(v)||v.length>3||!v.every(validCommunityLinkButton))return false;
 return new Set(v.map(x=>x.url)).size===v.length&&
  new Set(v.map(x=>x.text.normalize('NFKC').trim())).size===v.length;
}
export function validCommunityLinkKeyboard(v:unknown):v is CommunityLinkKeyboard{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;
 const data=v as Record<string,unknown>;
 if(Object.keys(data).length!==1||!Array.isArray(data.inline_keyboard)||
    data.inline_keyboard.length<1||data.inline_keyboard.length>3)return false;
 const rows=data.inline_keyboard as unknown[];
 if(!rows.every(row=>Array.isArray(row)&&row.length===1&&validCommunityLinkButton(row[0])))return false;
 return validCommunityLinkButtons(rows.flat());
}
export function communityLinkKeyboard(buttons:CommunityLinkButton[]|undefined):
 CommunityLinkKeyboard|undefined{
 if(!buttons?.length)return undefined;
 if(!validCommunityLinkButtons(buttons))throw Error('COMMUNITY_BUTTONS_INVALID');
 return {inline_keyboard:buttons.map(item=>[{text:item.text,url:item.url}])};
}
