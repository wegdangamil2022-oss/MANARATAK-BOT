/** 09:11 group-only study circles. No one-to-one matching and no member
 * contact information ever leaves this store through public views.
 */
export type StudyLevel='BEGINNER'|'INTERMEDIATE'|'ADVANCED';
export type StudyCircleStatus='DRAFT'|'OPEN'|'CANCELLED'|'CLOSED';
export type StudyReportReason='CONTACT_REQUEST'|'UNSAFE_MATCH'|'HARASSMENT';
export interface StudyCircle{
 id:string;chatId:string;chatVersion:number;ownerId:string;topic:string;
 level:StudyLevel;startsAt:number;endsAt:number;capacity:number;
 status:StudyCircleStatus;revision:number;createdAt:number;
 openedAt?:number;closedAt?:number;
}
export interface StudyMember{
 id:string;circleId:string;memberId:string;status:'JOINED'|'LEFT';
 revision:1|2;createdAt:number;leftAt?:number;
}
export interface StudyReport{
 id:string;circleId:string;reporterId:string;
 reason:StudyReportReason;createdAt:number;
}
export interface StudyPeerState{
 circles:StudyCircle[];members:StudyMember[];reports:StudyReport[];
}
export const emptyStudyPeerState=():StudyPeerState=>({
 circles:[],members:[],reports:[]
});
const rec=(v:unknown):v is Record<string,unknown>=>!!v&&
 typeof v==='object'&&!Array.isArray(v);
const exact=(x:Record<string,unknown>,req:readonly string[],other:readonly string[]=[]) =>
 req.every(y=>Object.hasOwn(x,y))&&
 Object.keys(x).every(y=>req.includes(y)||other.includes(y));
export const studyId=(v:unknown):v is string=>
 typeof v==='string'&&/^[a-f0-9]{24}$/u.test(v);
export const studyUser=(v:unknown):v is string=>
 typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
export const studyGroup=(v:unknown):v is string=>
 typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const time=(v:unknown):v is number=>
 typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-31*86_400_000;
const version=(v:unknown)=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
export const validStudyTopic=(v:unknown):v is string=>
 typeof v==='string'&&v.trim()===v&&v.length>=5&&v.length<=80&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v)&&
 !/(?:https?:\/\/|www\.|t\.me\/|@[\w]{3,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\d[\d\s+()-]{7,}\d)/iu.test(v);
export const validStudyInput=(v:unknown):v is {
 topic:string;level:StudyLevel;startsAt:number;durationMinutes:number;capacity:number;
}=>{
 if(!rec(v)||!exact(v,['topic','level','startsAt','durationMinutes','capacity'])||
  !validStudyTopic(v.topic)||!['BEGINNER','INTERMEDIATE','ADVANCED'].includes(String(v.level))||
  !time(v.startsAt)||!Number.isSafeInteger(v.durationMinutes)||
  Number(v.durationMinutes)<15||Number(v.durationMinutes)>240||
  !Number.isSafeInteger(v.capacity)||Number(v.capacity)<2||
  Number(v.capacity)>30)return false;
 return true;
};
export function validStudyCircle(v:unknown):v is StudyCircle{
 if(!rec(v)||!exact(v,['id','chatId','chatVersion','ownerId',
  'topic','level','startsAt','endsAt','capacity','status','revision','createdAt'],
  ['openedAt','closedAt'])||!studyId(v.id)||!studyGroup(v.chatId)||
  !studyUser(v.ownerId)||!version(v.chatVersion)||!version(v.revision)||
  !time(v.createdAt)||!time(v.startsAt)||!time(v.endsAt)||
  !validStudyInput({topic:v.topic,level:v.level,startsAt:v.startsAt,
   durationMinutes:(Number(v.endsAt)-Number(v.startsAt))/60_000,
   capacity:v.capacity})||
  Number(v.startsAt)-Number(v.createdAt)<600_000)return false;
 if(v.status==='DRAFT')return v.revision===1&&v.openedAt===undefined&&v.closedAt===undefined;
 if(v.status==='OPEN')return v.revision===2&&time(v.openedAt)&&
  Number(v.openedAt)>=v.createdAt&&Number(v.openedAt)<v.startsAt&&v.closedAt===undefined;
 if(v.status==='CANCELLED')return (v.revision===2||v.revision===3)&&
  time(v.closedAt)&&Number(v.closedAt)>=v.createdAt&&
  (v.openedAt===undefined?v.revision===2:
   v.revision===3&&time(v.openedAt)&&Number(v.openedAt)<v.startsAt&&
   Number(v.closedAt)>=v.openedAt);
 if(v.status==='CLOSED')return v.revision===3&&time(v.openedAt)&&
  Number(v.openedAt)>=v.createdAt&&Number(v.openedAt)<v.startsAt&&
  time(v.closedAt)&&Number(v.closedAt)>=v.endsAt;
 return false;
}
function validMember(v:unknown):v is StudyMember{
 if(!rec(v)||!exact(v,['id','circleId','memberId','status','revision','createdAt'],
  ['leftAt'])||!studyId(v.id)||!studyId(v.circleId)||!studyUser(v.memberId)||
  !time(v.createdAt))return false;
 if(v.status==='JOINED')return v.revision===1&&v.leftAt===undefined;
 if(v.status==='LEFT')return v.revision===2&&time(v.leftAt)&&
  Number(v.leftAt)>=v.createdAt;
 return false;
}
function validReport(v:unknown):v is StudyReport{
 return rec(v)&&exact(v,['id','circleId','reporterId','reason','createdAt'])&&
  studyId(v.id)&&studyId(v.circleId)&&studyUser(v.reporterId)&&
  ['CONTACT_REQUEST','UNSAFE_MATCH','HARASSMENT'].includes(String(v.reason))&&time(v.createdAt);
}
export function validStudyPeerState(v:unknown):v is StudyPeerState{
 if(!rec(v)||!exact(v,['circles','members','reports'])||
  !Array.isArray(v.circles)||v.circles.length>100||
  !Array.isArray(v.members)||v.members.length>3000||
  !Array.isArray(v.reports)||v.reports.length>500||
  v.circles.some(x=>!validStudyCircle(x))||
  v.members.some(x=>!validMember(x))||
  v.reports.some(x=>!validReport(x)))return false;
 const circles=v.circles as StudyCircle[],members=v.members as StudyMember[],
  reports=v.reports as StudyReport[];
 if(new Set(circles.map(x=>x.id)).size!==circles.length||
  new Set(members.map(x=>x.id)).size!==members.length||
  new Set(members.map(x=>x.circleId+':'+x.memberId)).size!==members.length||
  new Set(reports.map(x=>x.id)).size!==reports.length||
  new Set(reports.map(x=>x.circleId+':'+x.reporterId)).size!==reports.length)
  return false;
 const byId=new Map(circles.map(x=>[x.id,x])),active=new Map<string,number>();
 for(const row of members){
  const circle=byId.get(row.circleId);
  if(!circle||circle.openedAt===undefined||circle.status==='CANCELLED'||
   row.memberId===circle.ownerId||row.createdAt<circle.openedAt||
   row.createdAt>=circle.startsAt)return false;
  if(row.status==='JOINED'){
   const n=(active.get(circle.id)??0)+1;
   if(n>circle.capacity)return false;
   active.set(circle.id,n);
  }
 }
 for(const row of reports){
  const circle=byId.get(row.circleId);
  if(!circle||circle.status==='DRAFT'||circle.status==='CANCELLED'||
   row.createdAt<circle.openedAt!||row.createdAt>=circle.endsAt||
   circle.closedAt!==undefined&&row.createdAt>circle.closedAt)return false;
 }
 return true;
}
