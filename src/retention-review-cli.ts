/**
 * B2-Advanced v0.5.5: explicitly invoked, review-only external scheduler hook.
 *
 * IMPORTANT: No delete, no compactRetention, no Telegram transport, no owner
 * notification and NO timer. Enabling the in-store cadence does not launch this.
 * The host is solely responsible for scheduling, private state ACLs and audit.
 */
import {open,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {FakePurgeGateway,ModerationPurgeService} from './moderation-purge.js';

type RunnerStatus='DISABLED'|'NOT_DUE'|'CLOCK_ROLLBACK'|'READY';
export interface RetentionReviewRunnerReport {
 status:RunnerStatus;
 expiredObserved?:number;
 eligibleJobs?:number;
 reasonsToRedact?:number;
 evidenceIdsToRedact?:number;
 senderFiltersToRedact?:number;
}
const deny=(code:'RETENTION_RUNNER_INVALID_ARGUMENTS'|'RETENTION_RUNNER_OWNER_REQUIRED'|
  'RETENTION_RUNNER_UNSAFE_STATE_FILE'|'RETENTION_RUNNER_FAILED_CLOSED'):never=>{throw new Error(code)};

function parseArgs(args:readonly string[]):{path:string;engine:'json'|'sqlite'} {
 if(args.length!==5)deny('RETENTION_RUNNER_INVALID_ARGUMENTS');
 let mode=false,path:string|undefined,engine:string|undefined;
 for(let i=0;i<args.length;i++){
  const arg=args[i]!;
  if(arg==='--review-only'){
   if(mode)deny('RETENTION_RUNNER_INVALID_ARGUMENTS');
   mode=true;
  }else if(arg==='--store'||arg==='--engine'){
   if(i+1>=args.length)deny('RETENTION_RUNNER_INVALID_ARGUMENTS');
   const value=args[++i]!;
   if(!value||value.startsWith('--'))deny('RETENTION_RUNNER_INVALID_ARGUMENTS');
   if(arg==='--store'){
    if(path!==undefined)deny('RETENTION_RUNNER_INVALID_ARGUMENTS');
    path=value;
   }else{
    if(engine!==undefined)deny('RETENTION_RUNNER_INVALID_ARGUMENTS');
    engine=value;
   }
  }else deny('RETENTION_RUNNER_INVALID_ARGUMENTS');
 }
 if(!mode||!path||!isAbsolute(path)||path!==resolve(path)||/[\u0000-\u001f\u007f]/u.test(path)||
   !['json','sqlite'].includes(engine??''))throw new Error('RETENTION_RUNNER_INVALID_ARGUMENTS');
 return {path,engine:engine as 'json'|'sqlite'};
}

async function requirePrivateExistingFile(path:string,engine:'json'|'sqlite'):Promise<void>{
 try{
  // Refuse symlinks at ANY segment to avoid accidentally reading a redirected state.
  if(await realpath(path)!==path)deny('RETENTION_RUNNER_UNSAFE_STATE_FILE');
  const info=await lstat(path);
  if(!info.isFile()||info.size<16||(info.mode&0o077)!==0)
   deny('RETENTION_RUNNER_UNSAFE_STATE_FILE');
  if(engine==='sqlite'){
   const fd=await open(path,'r');
   try{
    const b=Buffer.alloc(16),{bytesRead}=await fd.read(b,0,16,0);
    if(bytesRead!==16||b.toString('utf8')!=='SQLite format 3\u0000')
     deny('RETENTION_RUNNER_UNSAFE_STATE_FILE');
   }finally{await fd.close();}
  }
 }catch{deny('RETENTION_RUNNER_UNSAFE_STATE_FILE');}
}
/** Tool-runner logic can be unit tested without invoking process, timers or network. */
export async function runRetentionReviewCli(
 argv:readonly string[],env:Readonly<Record<string,string|undefined>>,clock:()=>number=Date.now
):Promise<RetentionReviewRunnerReport>{
 const {path,engine}=parseArgs(argv);
 const ownerId=env.MANARATAK_OWNER_ID;
 if(!ownerId||!/^\d+$/.test(ownerId)||ownerId==='0')throw new Error('RETENTION_RUNNER_OWNER_REQUIRED');
 await requirePrivateExistingFile(path,engine);
 const store=new BotStore(path,{engine});
 const policy=new Policy(store,ownerId,clock);
 // A fake, non-networking gateway is a deliberately narrow type boundary.
 const svc=new ModerationPurgeService(store,policy,new FakePurgeGateway(),clock);
 // Validate persistent data before attempting to record a due checkpoint.
 await store.snapshot().catch(()=>{throw new Error('RETENTION_RUNNER_FAILED_CLOSED');});
 const result=await svc.tickRetentionReview().catch(()=>{throw new Error('RETENTION_RUNNER_FAILED_CLOSED');});
 if(result.status!=='READY')return {status:result.status};
 const notice=result.notice;
 if(!notice)throw new Error('RETENTION_RUNNER_FAILED_CLOSED');
 // Only aggregate counts are stdout material: never print DB path, owner ID,
 // message IDs, recipient IDs, review text, proof identifiers or plan digest.
 return {status:'READY',expiredObserved:notice.expiredObserved,
  eligibleJobs:notice.eligibleJobs,reasonsToRedact:notice.reasonsToRedact,
  evidenceIdsToRedact:notice.evidenceIdsToRedact,
  senderFiltersToRedact:notice.senderFiltersToRedact};
}
const directlyExecuted=process.argv[1]!==undefined&&
 fileURLToPath(import.meta.url)===resolve(process.argv[1]);
if(directlyExecuted){
 runRetentionReviewCli(process.argv.slice(2),process.env).then(result=>{
  process.stdout.write(JSON.stringify(result)+'\n');
 }).catch(e=>{
  // Security: error output is fixed-code only; never log raw file paths or IDs.
  const msg=e instanceof Error?e.message:'';
  const code=['RETENTION_RUNNER_INVALID_ARGUMENTS','RETENTION_RUNNER_OWNER_REQUIRED',
   'RETENTION_RUNNER_UNSAFE_STATE_FILE','RETENTION_RUNNER_FAILED_CLOSED'].includes(msg)
   ?msg:'RETENTION_RUNNER_FAILED_CLOSED';
  process.stderr.write(code+'\n');
  process.exitCode=2;
 });
}
