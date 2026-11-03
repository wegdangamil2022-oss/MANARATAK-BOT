export type GroupRulesMarkup={inline_keyboard:[[{text:string;url:string}],[{text:string;url:string}]]};
export function groupRulesMarkup(username:string):GroupRulesMarkup{
 if(/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.exec(username)?.[0]!==username)throw Error('INVALID_BOT_USERNAME');
 return {inline_keyboard:[[{text:'📨 اعتراض أو توضيح في الخاص',url:'https://t.me/'+username+'?start=appeals'}],[{text:'🚩 البلاغات وطريقة الإبلاغ',url:'https://t.me/'+username+'?start=reports'}]]};
}
export function validGroupRulesMarkup(value:unknown):value is GroupRulesMarkup{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>,rows=v.inline_keyboard;
 if(Object.keys(v).length!==1||!Array.isArray(rows)||rows.length!==2||!rows.every(row=>Array.isArray(row)&&row.length===1))return false;
 const first=rows[0][0],second=rows[1][0];if(!first||!second||typeof first!=='object'||typeof second!=='object'||Array.isArray(first)||Array.isArray(second))return false;
 const a=first as Record<string,unknown>,b=second as Record<string,unknown>;
 if(Object.keys(a).length!==2||Object.keys(b).length!==2||a.text!=='📨 اعتراض أو توضيح في الخاص'||b.text!=='🚩 البلاغات وطريقة الإبلاغ'||typeof a.url!=='string'||typeof b.url!=='string')return false;
 const match=/^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\?start=appeals$/u.exec(a.url);
 return !!match&&match[0]===a.url&&b.url==='https://t.me/'+match[1]+'?start=reports';
}
