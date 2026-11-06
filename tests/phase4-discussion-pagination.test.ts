import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {discussionOwnerScreen,validDiscussionOwnerRoute} from '../src/phase4-discussion-owner.js';
const OWNER='100',GROUP='-1001234';
for(const engine of ['json','sqlite'] as const){
 test('DISCUSS-013 '+engine+': every queued question is reachable using bounded owner-only pages',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'phase4-discuss-pages-'));try{
   const now=1_700_000_000_000;
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,OWNER,()=>now);
   await policy.approveChat(OWNER,GROUP,['navigation']);
   const svc=new Phase4DiscussionService(store,policy,()=>now,async()=> 'VERIFIED');
   const session=await svc.draft(OWNER,GROUP,{title:'مجموعة أسئلة الطلاب',durationMinutes:60,maxQuestions:30});
   await svc.open(OWNER,session.id,1);
   const storedIds:string[]=[];
   for(let i=0;i<25;i++){
    const row=await svc.ask(String(300+i),session.id,'سؤال عن شروط المنح رقم '+i+'؟');
    assert.equal(row.status,'RECEIVED');storedIds.push(row.questionId!);
   }
   const detail=await discussionOwnerScreen(svc,OWNER,'dq:1:s:'+session.id);
   assert.match(detail?.text??'',new RegExp(session.id));
   const found:string[]=[];
   for(let page=0;page<3;page++){
    const command=page===0?'dq:1:l:'+session.id:'dq:1:p:'+session.id+':'+page;
    assert.equal(validDiscussionOwnerRoute(command),true);
    const screen=await discussionOwnerScreen(svc,OWNER,command);
    assert.match(screen?.text??'',new RegExp('صفحة '+(page+1)+' من 3'));
    const actions=screen?.keyboard.inline_keyboard.flat().map(b=>b.callback_data)??[];
    const qids=actions.filter(x=>x.startsWith('dq:1:q:')).map(x=>x.slice('dq:1:q:'.length));
    assert.equal(qids.length,page===2?5:10);
    found.push(...qids);
    if(page===1){
     assert.ok(actions.includes('dq:1:p:'+session.id+':0'));
     assert.ok(actions.includes('dq:1:p:'+session.id+':2'));
    }
   }
   assert.deepEqual(new Set(found),new Set(storedIds));
   assert.equal(await discussionOwnerScreen(svc,OWNER,'dq:1:p:'+session.id+':10'),null);
   assert.equal(await discussionOwnerScreen(svc,'201','dq:1:p:'+session.id+':0'),null);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
