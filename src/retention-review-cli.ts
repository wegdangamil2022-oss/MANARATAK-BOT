import {parseRetentionRunnerArgs,runRetentionReviewOnce} from './retention-review-runner.js';

// Deliberately no Telegram Bot API imports, token flags or owner auth by
// CLI argument. It can ONLY trigger an owner-preconfigured read-only review.
try {
 const result=await runRetentionReviewOnce(parseRetentionRunnerArgs(process.argv.slice(2)));
 process.stdout.write(JSON.stringify(result)+'\n');
} catch(err) {
 // Never echo command-line values, file paths, raw metadata or secrets.
 const code=(err as Error)?.message;
 const safe=new Set([
  'INVALID_RETENTION_RUNNER_ARGS','RETENTION_STATE_FILE_REQUIRED',
  'RETENTION_STATE_FILE_INVALID','RETENTION_STATE_FILE_NOT_REGULAR',
  'RETENTION_STATE_FILE_INSECURE_PERMISSIONS','INVALID_RETENTION_SCHEDULE'
 ]);
 process.stderr.write((safe.has(code)?code:'RETENTION_RUNNER_FAILED')+'\n');
 process.exitCode=1;
}
