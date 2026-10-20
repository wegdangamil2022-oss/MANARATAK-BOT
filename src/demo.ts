import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from './store.js';
import { Policy } from './policy.js';
import { FakeTelegramGateway, UpdatePipeline } from './pipeline.js';
import { CallbackActionCodec } from './callback.js';

if (process.argv.includes('--simulate')) {
  const dir = await mkdtemp(join(tmpdir(), 'manaratak-sim-'));
  try {
    const store = new BotStore(join(dir, 'state.json'));
    const policy = new Policy(store, '123456789'); // fake trusted owner ID, not a Telegram login
    const gateway = new FakeTelegramGateway();
    const pipeline = new UpdatePipeline(store, policy, gateway, new CallbackActionCodec(store));
    const denied = await pipeline.handle({ botId: 'demo', updateId: 1, kind: 'message', chatKind: 'group', chatId: '-987', actorId: '777', hasFile: true });
    await policy.approveChat('123456789', '-555', ['assistant', 'navigation']);
    await policy.configureGroupAI('123456789', '-555', 'ALL_MENTION');
    const disabled = await pipeline.handle({ botId: 'demo', updateId: 2, kind: 'message', chatKind: 'group', chatId: '-555', actorId: '777', mentionTarget: 'bot' });
    console.log(JSON.stringify({ mode: 'SIMULATION_ONLY', unapprovedGroup: denied, fakeLeaveCount: gateway.leaves.length, approvedAIAttempt: disabled, liveConnections: 0 }, null, 2));
  } finally { await rm(dir, { recursive: true, force: true }); }
} else {
  console.error('This B1 package has no Telegram runtime. Run: npm run demo');
  process.exitCode = 1;
}
