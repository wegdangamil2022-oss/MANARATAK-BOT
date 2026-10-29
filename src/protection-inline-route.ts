export type ProtectionUIRoute={kind:'home';page:number}|{kind:'cancel';nonce:string}|
 {kind:'g'|'w'|'f'|'t'|'m'|'o'|'l'|'r'|'e'|'d'|'x'|'a'|'v';page:number;slot:number;digest:string;rulePage?:number;ruleSlot?:number;action?:'REVIEW'|'WARN'|'DELETE'|'MUTE'};
const p='(0|[1-9][0-9]{0,2})',s='([1-8])',d='([a-f0-9]{16})';
const simple=new RegExp('^pr:1:([gwftmo]):'+p+':'+s+':'+d+'$','u');
const list=new RegExp('^pr:1:(l):'+p+':'+s+':'+d+':'+p+'$','u');
const rule=new RegExp('^pr:1:([redxv]):'+p+':'+s+':'+d+':'+p+':'+s+'$','u');
const action=new RegExp('^pr:1:(a):'+p+':'+s+':'+d+':'+p+':'+s+':([rwdm])$','u');
export function protectionInlineRoute(data:string):ProtectionUIRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='pr:1:h')return {kind:'home',page:0};
 const page=new RegExp('^pr:1:p:'+p+'$','u').exec(data);
 if(page?.[0]===data)return {kind:'home',page:Number(page[1])};
 const cancel=/^pr:1:z:([A-Za-z0-9_-]{16})$/u.exec(data);
 if(cancel?.[0]===data)return {kind:'cancel',nonce:cancel[1]!};
 for(const regex of [simple,list,rule,action]){
  const m=regex.exec(data);if(!m||m[0]!==data)continue;
  return {kind:m[1] as Exclude<ProtectionUIRoute['kind'],'home'|'cancel'>,page:Number(m[2]),slot:Number(m[3]),digest:m[4]!,
   ...(m[5]===undefined?{}:{rulePage:Number(m[5])}),...(m[6]===undefined?{}:{ruleSlot:Number(m[6])}),
   ...(m[7]===undefined?{}:{action:({r:'REVIEW',w:'WARN',d:'DELETE',m:'MUTE'} as const)[m[7] as 'r'|'w'|'d'|'m']})};
 }
 return null;
}
