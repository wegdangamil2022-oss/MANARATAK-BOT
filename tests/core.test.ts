import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { UpdatePipeline, FakeTelegramGateway } from '../src/pipeline.js';
import { CallbackActionCodec } from '../src/callback.js';
import { OutboundPriorityPolicy } from '../src/outbound.js';
import { WizardSessionStore } from '../src/wizard.js';

async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'manaratak-test-'));
  const path = join(folder, 'state.json');
  const store = new BotStore(path);
  const policy = new Policy(store, '100', () => 1_000);
  const gateway = new FakeTelegramGateway();
  const codec = new CallbackActionCodec(store, () => 1_000);
  const pipeline = new UpdatePipeline(store, policy, gateway, codec, () => 1_000);
  return { path, store, policy, gateway, codec, pipeline, close: () => rm(folder, { recursive: true, force: true }) };
}

test('T12-07/T121-01 unknown group rejects content before download/AI, and leave is recorded', async () => {
  const s = await setup();
  try {
    const r = await s.pipeline.handle({ botId: 'bot', updateId: 1, kind: 'message', chatKind: 'group', chatId: '-10', actorId: '200', hasFile: true, mentionTarget: 'bot' });
    assert.equal(r.status, 'DENIED');
    assert.equal(s.gateway.leaves.length, 1);
    assert.equal(s.gateway.downloads, 0);
    assert.equal(s.gateway.aiCalls, 0);
    const audit = await s.store.snapshot();
    assert.equal(audit.operations.length, 1);
    assert.equal(audit.operations[0]?.kind, 'CHAT_LEAVE');
    assert.equal(audit.operations[0]?.status, 'CONFIRMED');
    assert.equal(audit.audit[0]?.reason, 'CHAT_NOT_APPROVED');
    assert.equal(JSON.stringify(audit).includes('secret question'), false);
  } finally { await s.close(); }
});

test('T121-02 group permission is not bot presence; revoked permission denies', async () => {
  const s = await setup();
  try {
    await s.policy.approveChat('100', '-10', ['navigation', 'assistant']);
    await s.policy.setPresence('-10', true);
    assert.equal(s.policy.canUseChat(await s.store.snapshot(), '-10', 'navigation'), true);
    await s.policy.revokeChat('100', '-10');
    assert.equal(s.policy.canUseChat(await s.store.snapshot(), '-10', 'navigation'), false);
    const r = await s.pipeline.handle({ botId: 'bot', updateId: 2, kind: 'message', chatKind: 'group', chatId: '-10', actorId: '200', mentionTarget: 'bot' });
    assert.equal(r.status, 'DENIED');
  } finally { await s.close(); }
});

test('T12-01..03 owner/staff/all group mention policy is independent, and AI stays disabled', async () => {
  const s = await setup();
  try {
    await s.policy.approveChat('100', '-10', ['assistant']);
    await s.policy.configureGroupAI('100', '-10', 'OWNER_MENTION');
    assert.equal(s.policy.mayAskGroup(await s.store.snapshot(), '-10', '200', true), false);
    assert.equal(s.policy.mayAskGroup(await s.store.snapshot(), '-10', '100', true), true);
    await s.policy.configureGroupAI('100', '-10', 'STAFF_MENTION');
    await s.policy.grant('100', '201', 'ai.ask', '-10', 9_000);
    assert.equal(s.policy.mayAskGroup(await s.store.snapshot(), '-10', '201', true), true);
    assert.equal(s.policy.has(await s.store.snapshot(), '201', 'content.publish', '-10', 1_000), false);
    await s.policy.configureGroupAI('100', '-10', 'ALL_MENTION');
    assert.equal(s.policy.mayAskGroup(await s.store.snapshot(), '-10', '200', false), false);
    assert.equal(s.policy.mayAskGroup(await s.store.snapshot(), '-10', '200', true), true);
    const r = await s.pipeline.handle({ botId: 'bot', updateId: 5, kind: 'message', chatKind: 'group', chatId: '-10', actorId: '200', mentionTarget: 'bot' });
    assert.equal(r.reason, 'AI_NOT_CONFIGURED');
    assert.equal(s.gateway.aiCalls, 0);
  } finally { await s.close(); }
});

test('T12-05 private AI toggle does not disable owner dashboard, verification or education', async () => {
  const s = await setup();
  try {
    await s.policy.configurePrivateAI('100', 'OFF');
    const p = await s.store.snapshot();
    assert.equal(s.policy.mayAskPrivate(p, '200', true), false);
    assert.equal(s.policy.privateFeature(p, 'owner.dashboard', '100'), true);
    assert.equal(s.policy.privateFeature(p, 'subscription.verify', '200'), true);
    assert.equal(s.policy.privateFeature(p, 'education.navigate', '200'), true);
  } finally { await s.close(); }
});

test('T12-02 scoped nondelegating grants prevent self-grant, elevation and scope bleed', async () => {
  const s = await setup();
  try {
    await s.policy.approveChat('100','-10',['assistant']);
    await s.policy.grant('100', '201', 'ai.ask', '-10', 2_000);
    await assert.rejects(s.policy.grant('201', '201', 'content.publish', '-10', 3_000));
    await assert.rejects(s.policy.grant('201', '202', 'ai.ask', '-10', 3_000));
    assert.equal(s.policy.has(await s.store.snapshot(), '201', 'ai.ask', '-11', 1_000), false);
    assert.equal(s.policy.has(await s.store.snapshot(), '201', 'ai.ask', '-10', 2_001), false);
    await s.policy.revokeGrant('100', '201', 'ai.ask', '-10');
    assert.equal(s.policy.has(await s.store.snapshot(), '201', 'ai.ask', '-10', 1_000), false);
  } finally { await s.close(); }
});

test('T121-01 duplicate updates remain idempotent through restart; redacted state persists', async () => {
  const s = await setup();
  try {
    await s.policy.approveChat('100', '-10', ['navigation']);
    const input = { botId: 'bot', updateId: 20, kind: 'message' as const, chatKind: 'group' as const, chatId: '-10', actorId: '200' };
    const [a, b] = await Promise.all([s.pipeline.handle(input), s.pipeline.handle(input)]);
    assert.equal([a.status, b.status].filter(x => x === 'DUPLICATE').length, 1);
    const restarted = new UpdatePipeline(new BotStore(s.path), new Policy(new BotStore(s.path), '100'), s.gateway, s.codec, () => 1_000);
    assert.equal((await restarted.handle(input)).status, 'DUPLICATE');
    assert.equal((await s.store.snapshot()).updates.length, 1);
  } finally { await s.close(); }
});

test('T121-03 expired lease after begun mutation stays UNKNOWN, not resent automatically', async () => {
  const s = await setup();
  try {
    await s.store.claim('bot:50', 1_000, 100);
    const op = await s.store.addIntent('bot:50', 'CHAT_LEAVE', '-10', 1);
    await s.store.markStarted(op, 1_001);
    const state = await s.store.claim('bot:50', 1_200, 100);
    assert.equal(state, 'UNKNOWN');
    assert.equal((await s.store.snapshot()).operations[0]?.status, 'UNKNOWN_OUTCOME');
    assert.equal(s.gateway.leaves.length, 0);
  } finally { await s.close(); }
});

test('T121-05 callbacks are small, scoped, timebound, admin bound vs public, reusable vs one-shot', async () => {
  const s = await setup();
  try {
    const admin = await s.codec.issue({ action: 'owner.dashboard', chatId: '100', actorId: '100', policyVersion: 1, expiresAt: 1_500, oneShot: true });
    assert.ok(Buffer.byteLength(admin, 'utf8') <= 64);
    assert.equal(admin.includes('owner.dashboard'), false);
    assert.equal((await s.codec.consume(admin, '201', '100', 1, () => true)).ok, false);
    assert.equal((await s.codec.consume(admin, '100', '100', 1, () => true)).ok, true);
    assert.equal((await s.codec.consume(admin, '100', '100', 1, () => true)).ok, false);
    await s.policy.approveChat('100', '-10', ['navigation']);
    const pub = await s.codec.issue({ action: 'education.navigate', chatId: '-10', policyVersion: 1, expiresAt: 2_000, oneShot: false });
    assert.equal((await s.codec.consume(pub, '201', '-10', 1, () => true)).ok, true);
    assert.equal((await s.codec.consume(pub, '202', '-10', 1, () => true)).ok, true);
    assert.equal((await s.codec.consume(pub, '202', '-10', 2, () => true)).ok, false);
    assert.equal((await s.codec.consume(pub, '202', '-10', 1, () => false)).ok, false);
  } finally { await s.close(); }
});

test('T121-06 P0/P1/P2 fairness and rate-limit retry without retrying unknown outcomes', () => {
  let now = 1_000;
  const q = new OutboundPriorityPolicy(() => now);
  for (let i = 0; i < 24; i++) q.enqueue({ id: 'p0-' + i, chatId: '-1', priority: 'P0', result: 'QUEUED' });
  q.enqueue({ id: 'p1', chatId: '-2', priority: 'P1', result: 'QUEUED' });
  q.enqueue({ id: 'p2', chatId: '-3', priority: 'P2', result: 'QUEUED' });
  q.enqueue({ id: 'unknown', chatId: '-4', priority: 'P0', result: 'UNKNOWN_OUTCOME' });
  const scheduled = Array.from({ length: 12 }, () => q.next()?.id);
  assert.ok(scheduled.includes('p1'));
  assert.ok(scheduled.includes('p2'));
  assert.ok(!scheduled.includes('unknown'));
  q.retryAfter('-1', 5_000);
  assert.notEqual(q.next()?.chatId, '-1');
  now = 6_001;
  assert.equal(q.next()?.chatId, '-1');
});

test('T121-07 wizard isolates topic/flow, CAS blocks double transitions; expires, backs, cancels and restart', async () => {
  const s = await setup();
  try {
    const wizard = new WizardSessionStore(s.store, () => 1_000);
    const scope = { userId: '201', chatId: '-10', topicId: '5', flow: 'example' };
    const created = await wizard.begin(scope, 2_000, 1);
    assert.equal((await wizard.begin({ ...scope, topicId: '6' }, 2_000, 1)).version, 1);
    const [first, second] = await Promise.all([
      wizard.move(scope, created.version, 'NEXT', 1, () => true),
      wizard.move(scope, created.version, 'NEXT', 1, () => true)
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    const persisted = new WizardSessionStore(new BotStore(s.path), () => 1_000);
    const w = await persisted.get(scope);
    assert.equal(w?.step, 1);
    assert.equal(await persisted.move(scope, w!.version, 'BACK', 2, () => true), false);
    assert.equal(await persisted.move(scope, w!.version, 'BACK', 1, () => true), true);
    assert.equal(await persisted.move(scope, w!.version + 1, 'CANCEL', 1, () => true), true);
    assert.equal(await persisted.get(scope), null);
    const expired = { userId: '201', chatId: '-10', flow: 'expires' };
    await wizard.begin(expired, 999, 1);
    assert.equal(await wizard.get(expired), null);
  } finally { await s.close(); }
});

test('T121-01 invalid transport, missing actor and unknown inline never bypass boundary', async () => {
  const s = await setup();
  try {
    assert.equal((await s.pipeline.handle({ botId: 'bot', updateId: 1, kind: 'message', chatId: '100', chatKind: 'private', actorId: '100', transportVerified: false })).reason, 'INVALID_ENVELOPE');
    assert.equal((await s.store.snapshot()).updates.length, 0);
    assert.equal((await s.pipeline.handle({ botId: 'bot', updateId: 2, kind: 'message', chatId: '100', chatKind: 'private' })).reason, 'MISSING_ACTOR');
    assert.equal((await s.pipeline.handle({ botId: 'bot', updateId: 3, kind: 'inline', actorId: '100' })).reason, 'INLINE_DISABLED');
  } finally { await s.close(); }
});

test('T121-02 callback verification bypasses subscription requirement but not chat authorization', async () => {
  const s = await setup();
  try {
    await s.policy.approveChat('100', '-10', ['verification']);
    const revision = s.policy.chatRevision(await s.store.snapshot(), '-10');
    const ref = await s.codec.issue({ action: 'subscription.verify', chatId: '-10', policyVersion: revision, expiresAt: 5_000, oneShot: false });
    const good = await s.pipeline.handle({ botId: 'bot', updateId: 30, kind: 'callback', chatKind: 'group', chatId: '-10', actorId: '200', callbackRef: ref, subscriptionVerified: false });
    assert.equal(good.status, 'ALLOWED');
    assert.deepEqual(s.gateway.callbackAcks, [30]);
    await s.policy.revokeChat('100', '-10');
    const bad = await s.pipeline.handle({ botId: 'bot', updateId: 31, kind: 'callback', chatKind: 'group', chatId: '-10', actorId: '200', callbackRef: ref });
    assert.equal(bad.status, 'DENIED');
  } finally { await s.close(); }
});

test('T121-04 gateway rights missing block allowed group action', async () => {
  const s = await setup();
  try {
    await s.policy.approveChat('100', '-10', ['assistant']);
    await s.policy.configureGroupAI('100', '-10', 'ALL_MENTION');
    s.gateway.rights = false;
    const result = await s.pipeline.handle({ botId: 'bot', updateId: 70, kind: 'message', chatId: '-10', chatKind: 'group', actorId: '200', mentionTarget: 'bot' });
    assert.equal(result.reason, 'BOT_RIGHTS_MISSING');
  } finally { await s.close(); }
});

test('T121-01 leave outcome UNKNOWN is persisted, duplicated update does not call leave again', async () => {
  const s = await setup();
  try {
    s.gateway.leaveChat = async () => { throw new Error('timeout after send'); };
    const update = { botId: 'bot', updateId: 50, kind: 'membership' as const, chatId: '-99', chatKind: 'group' as const };
    await s.pipeline.handle(update);
    assert.equal((await s.store.snapshot()).operations[0]?.status, 'UNKNOWN_OUTCOME');
    assert.equal((await s.pipeline.handle(update)).status, 'UNKNOWN');
  } finally { await s.close(); }
});

test('T121-06 outbound revalidates current permissions when dequeuing stale jobs', () => {
  const q = new OutboundPriorityPolicy(() => 1_000);
  q.enqueue({ id: 'revoked', chatId: '-10', priority: 'P0', result: 'QUEUED' });
  q.enqueue({ id: 'allowed', chatId: '-11', priority: 'P1', result: 'QUEUED' });
  assert.equal(q.next(item => item.chatId !== '-10')?.id, 'allowed');
  assert.equal(q.length, 0);
});
