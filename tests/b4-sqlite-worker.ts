import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { FakePublicationGateway, PublicationService } from '../src/publishing.js';

const [task,filename,campaign] = process.argv.slice(2);
if (!task || !filename || !campaign) throw new Error('MISSING_WORKER_ARGS');
const store = new BotStore(filename,{engine:'sqlite'});
const clock=()=>1000, policy=new Policy(store,'100',clock), gateway=new FakePublicationGateway();
const publishing=new PublicationService(store,policy,gateway,clock);
if(task==='approve') {
  const result=await publishing.approve('100',campaign);
  process.stdout.write('APPROVED:'+result.id+'\n');
} else if(task==='dispatch') {
  const result=await publishing.dispatchNext(campaign);
  process.stdout.write(result.status+':'+gateway.calls.length+'\n');
} else if(task==='recover') {
  const recovered=await publishing.recoverPending();
  process.stdout.write('RECOVERED:'+recovered+'\n');
} else throw new Error('UNKNOWN_WORKER_TASK');
