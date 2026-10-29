export type ProtectionUIRoute={kind:'home';page:number}|{kind:'cancel';nonce:string}|
 {kind:'g'|'w'|'f'|'t'|'m'|'o'|'l'|'r'|'e'|'d'|'x'|'a'|'v'|'b'|'j'|'y'|'n'|'c'|'u'|'s'|'q'|'k'|'S'|'F'|'T'|'A';page:number;slot:number;digest:string;rulePage?:number;ruleSlot?:number;listKind?:'d'|'p';action?:'REVIEW'|'WARN'|'DELETE'|'MUTE'};
const p='(0|[1-9][0-9]{0,2})',s='([1-8])',d='([a-f0-9]{16})';
const simple=new RegExp('^pr:1:([gwftmobjcuSFT]):'+p+':'+s+':'+d+'$','u');
const list=new RegExp('^pr:1:([ly]):'+p+':'+s+':'+d+':'+p+'$','u');
const rule=new RegExp('^pr:1:([redxvns]):'+p+':'+s+':'+d+':'+p+':'+s+'$','u');
const action=new RegExp('^pr:1:(a):'+p+':'+s+':'+d+':'+p+':'+s+':([rwdm])$','u');
const allow=new RegExp('^pr:1:([qk]):'+p+':'+s+':'+d+':'+p+':'+s+':([dp])$','u');
export function protectionInlineRoute(data:string):ProtectionUIRoute|null{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 if(data==='pr:1:h')return {kind:'home',page:0};
 const page=new RegExp('^pr:1:p:'+p+'$','u').exec(data);
 if(page?.[0]===data)return {kind:'home',page:Number(page[1])};
 const cancel=/^pr:1:z:([A-Za-z0-9_-]{16})$/u.exec(data);
 if(cancel?.[0]===data)return {kind:'cancel',nonce:cancel[1]!};
 const flood=new RegExp('^pr:1:A:'+p+':'+s+':'+d+':([rwdm])$','u').exec(data);
 if(flood?.[0]===data)return {kind:'A',page:Number(flood[1]),slot:Number(flood[2]),digest:flood[3]!,action:({r:'REVIEW',w:'WARN',d:'DELETE',m:'MUTE'} as const)[flood[4] as 'r'|'w'|'d'|'m']};
 for(const regex of [simple,list,rule,action,allow]){
  const m=regex.exec(data);if(!m||m[0]!==data)continue;
  return {kind:m[1] as Exclude<ProtectionUIRoute['kind'],'home'|'cancel'>,page:Number(m[2]),slot:Number(m[3]),digest:m[4]!,
   ...(m[5]===undefined?{}:{rulePage:Number(m[5])}),...(m[6]===undefined?{}:{ruleSlot:Number(m[6])}),
   ...(regex===allow?{listKind:m[7] as 'd'|'p'}:{}),
   ...(m[7]===undefined||regex===allow?{}:{action:({r:'REVIEW',w:'WARN',d:'DELETE',m:'MUTE'} as const)[m[7] as 'r'|'w'|'d'|'m']})};
 }
 return null;
}
