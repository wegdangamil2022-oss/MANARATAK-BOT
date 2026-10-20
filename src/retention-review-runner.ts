import {lstat} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {ModerationPurgeService,type PurgeGateway} from './moderation-purge.js';

export interface RetentionRunnerArgs {statePath:string;engine:'json'|'sqlite'}
export type RetentionRunnerResult =
 | {status:'DISABLED'|'NOT_DUE'|'CLOCK_ROLLBACK'}
 | {status:'READY';expiredObserved:number;eligibleJobs:number};
/** Explicit, local-only, one-shot runner. No defaults, token inputs, remote gateway
 * or administrative owner action. Passing an ID on a command line is NOT auth. */
export function parseRetentionRunnerArgs(args:readonly string[]):RetentionRunnerArgs {
 const fields=new Map<string,string>(), allowed=new Set(['--state','--engine']);
 let once=false;
 for(let i=0;i<args.length;i++){
  const key=args[i]!;
  if(key==='--once'){
   if(once)throw new Error('INVALID_RETENTION_RUNNER_ARGS');
   once=true;continue;
  }
  if(!allowed.has(key)||fields.has(key)||i+1>=args.length)
   throw new Error('INVALID_RETENTION_RUNNER_ARGS');
  const value=args[++i]!;
  if(!value||value.startsWith('--'))throw new Error('INVALID_RETENTION_RUNNER_ARGS');
  fields.set(key,value);
 }
 const statePath=fields.get('--state'), engine=fields.get('--engine');
 if(!once||fields.size!==2||!statePath||!isAbsolute(statePath)||
    (engine!=='json'&&engine!=='sqlite'))throw new Error('INVALID_RETENTION_RUNNER_ARGS');
 return {statePath:resolve(statePath),engine};
}
/** Privileged local operator must provide an already-initialized, private,
 * regular and non-symlink local file; this does not replace OS ACLs or sandboxing.
 * Only the dry-run tick is reachable, never compaction or Telegram deletion. */
export async function runRetentionReviewOnce(
 opts:RetentionRunnerArgs,clock:()=>number=Date.now
):Promise<RetentionRunnerResult>{
 if(!opts||!isAbsolute(opts.statePath)||(opts.engine!=='json'&&opts.engine!=='sqlite'))
  throw new Error('INVALID_RETENTION_RUNNER_ARGS');
 let meta:Awaited<ReturnType<typeof lstat>>;
 try { meta=await lstat(opts.statePath); }
 catch(err){
  if((err as NodeJS.ErrnoException).code==='ENOENT')throw new Error('RETENTION_STATE_FILE_REQUIRED');
  throw new Error('RETENTION_STATE_FILE_INVALID');
 }
 if(!meta.isFile()||meta.isSymbolicLink())throw new Error('RETENTION_STATE_FILE_NOT_REGULAR');
 if((meta.mode&0o077)!==0)throw new Error('RETENTION_STATE_FILE_INSECURE_PERMISSIONS');
 const store=new BotStore(opts.statePath,{engine:opts.engine});
 await store.snapshot(); // fails closed on invalid schema; never creates a missing JSON file
 const noOutbound:PurgeGateway={
  canDelete:async()=>false,
  deleteMessage:async()=>{throw new Error('RETENTION_RUNNER_NO_NETWORK_DELETE');},
  verifyEvidence:async()=>false
 };
 // Synthetic owner ID exists only to satisfy the Policy constructor. No owner
 // authentication or privileged owner methods are exposed by this runner.
 const purge=new ModerationPurgeService(store,new Policy(store,'1',clock),noOutbound,clock);
 const r=await purge.tickRetentionReview();
 return r.status==='READY'
  ? {status:'READY',expiredObserved:r.notice!.expiredObserved,eligibleJobs:r.notice!.eligibleJobs}
  : {status:r.status};
}
