import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { ModerationService, FakeModerationGateway } from '../src/moderation.js';
import { SubscriptionGate, FakeMembershipGateway } from '../src/subscription.js';

const OWNER = '100'; const STAFF = '200'; const MEMBER = '300'; const GROUP = '-10'; const CH1 = '-51'; const CH2 = '-52';
async function context() {
  const dir = await mkdtemp(join(tmpdir(), 'manaratak-b2-'));
  const file = join(dir, 'state.json');
  const store = new BotStore(file);
  const policy = new Policy(store, OWNER, () => 1_000);
  const gateway = new FakeModerationGateway();
  const moderation = new ModerationService(store, policy, gateway, () => 1_000);
  const members = new FakeMembershipGateway();
  const subscription = new SubscriptionGate(store, policy, members, moderation, () => 1_000);
  await policy.approveChat(OWNER, GROUP, ['moderation', 'verification', 'assistant']);
  return { dir, file, store, policy, gateway, moderation, members, subscription, close: () => rm(dir, { recursive: true, force: true }) };
}

test('B2 MOD-004 default-deny, target protection and actual bot rights trump internal grants', async () => {
  const c = await context();
  try {
    assert.equal((await c.moderation.addManualReason(STAFF, GROUP, MEMBER, 'case-1', 'MUTE')).status, 'DENIED');
    await c.policy.grant(OWNER, STAFF, 'chat.manage', GROUP, 2_000);
    assert.equal((await c.moderation.addManualReason(STAFF, '-99', MEMBER, 'case-1', 'MUTE')).status, 'DENIED');
    assert.equal((await c.moderation.addManualReason(STAFF, GROUP, OWNER, 'case-1', 'BAN')).status, 'DENIED');
    c.gateway.protectedMembers.add(GROUP + ':' + MEMBER);
    assert.equal((await c.moderation.addManualReason(STAFF, GROUP, MEMBER, 'case-1', 'BAN')).status, 'DENIED');
    c.gateway.protectedMembers.clear();
    c.gateway.rights = false;
    assert.equal((await c.moderation.addManualReason(STAFF, GROUP, MEMBER, 'case-1', 'MUTE')).status, 'DENIED');
    assert.equal(c.gateway.calls.length, 0);
  } finally { await c.close(); }
});

test('B2 MOD-004 removing subscription restriction never lifts another manual mute', async () => {
  const c = await context();
  try {
    assert.equal((await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'review-1', 'MUTE')).status, 'APPLIED');
    assert.equal((await c.moderation.setSubscriptionReason(GROUP, MEMBER, CH1, true)).status, 'NO_CHANGE');
    assert.equal((await c.moderation.setSubscriptionReason(GROUP, MEMBER, CH1, false)).status, 'NO_CHANGE');
    assert.deepEqual(c.gateway.calls.map(x => x.kind), ['MUTE']);
    assert.equal(c.moderation.effective(await c.store.snapshot(), GROUP, MEMBER), 'MUTE');
    assert.equal((await c.moderation.removeManualReason(OWNER, GROUP, MEMBER, 'review-1')).status, 'APPLIED');
    assert.deepEqual(c.gateway.calls.map(x => x.kind), ['MUTE', 'NONE']);
  } finally { await c.close(); }
});

test('B2 MOD-005 overlapping ban and mute downgrades to mute only after ban removal', async () => {
  const c = await context();
  try {
    await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'spam-1', 'MUTE');
    await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'fraud-1', 'BAN');
    assert.equal((await c.moderation.removeManualReason(OWNER, GROUP, MEMBER, 'fraud-1')).status, 'APPLIED');
    assert.equal(c.moderation.effective(await c.store.snapshot(), GROUP, MEMBER), 'MUTE');
    assert.deepEqual(c.gateway.calls.map(x => x.kind), ['MUTE', 'BAN', 'MUTE']);
  } finally { await c.close(); }
});

test('B2 rejected and duplicate manual reasons cannot mutate chat state', async () => {
  const c = await context();
  try {
    assert.equal((await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'a', 'MUTE')).status, 'APPLIED');
    assert.equal((await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'a', 'MUTE')).status, 'NO_CHANGE');
    await assert.rejects(c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'a', 'BAN'), /CONFLICT/);
    assert.equal((await c.moderation.removeManualReason(OWNER, GROUP, MEMBER, 'absent')).status, 'NO_CHANGE');
    assert.equal(c.gateway.calls.length, 1);
  } finally { await c.close(); }
});

test('B2 unknown Telegram outcome blocks replay even after process restart', async () => {
  const c = await context();
  try {
    c.gateway.throwAfterSend = true;
    assert.equal((await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'a', 'MUTE')).status, 'UNKNOWN_OUTCOME');
    const fresh = new ModerationService(new BotStore(c.file), new Policy(new BotStore(c.file), OWNER, () => 1_000), c.gateway, () => 1_000);
    c.gateway.throwAfterSend = false;
    assert.equal((await fresh.reconcile(OWNER, GROUP, MEMBER)).status, 'BLOCKED_UNKNOWN');
    assert.equal(c.gateway.calls.length, 1);
    assert.equal((await c.store.snapshot()).moderationOperations.at(-1)?.status, 'UNKNOWN_OUTCOME');
  } finally { await c.close(); }
});

test('B2 denied policy between intent and gateway effect cancels unsent operation', async () => {
  const c = await context();
  try {
    c.moderation.beforeDispatch = async () => { await c.policy.revokeChat(OWNER, GROUP); };
    assert.equal((await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'a', 'MUTE')).status, 'DENIED');
    assert.equal(c.gateway.calls.length, 0);
    assert.equal((await c.store.snapshot()).moderationOperations.at(-1)?.status, 'CANCELLED');
  } finally { await c.close(); }
});

test('B2 scopes, current delegation and per-member Telegram rights are rechecked for each action', async () => {
  const c = await context();
  try {
    await c.policy.grant(OWNER, STAFF, 'chat.manage', GROUP, 1_500);
    c.moderation.beforeDispatch = async () => { await c.policy.revokeGrant(OWNER, STAFF, 'chat.manage', GROUP); };
    assert.equal((await c.moderation.addManualReason(STAFF, GROUP, MEMBER, 'a', 'MUTE')).status, 'DENIED');
    assert.equal(c.gateway.calls.length, 0);
    c.moderation.beforeDispatch = undefined;
    assert.equal((await c.moderation.reconcile(STAFF, GROUP, MEMBER)).status, 'DENIED');
    assert.equal((await c.moderation.reconcile(OWNER, GROUP, MEMBER)).status, 'APPLIED');
  } finally { await c.close(); }
});

test('B2 concurrent moderation reconciles only once for same member', async () => {
  const c = await context();
  try {
    const [x, y] = await Promise.all([c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'a', 'MUTE'), c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'a', 'MUTE')]);
    assert.ok([x.status, y.status].includes('APPLIED'));
    assert.equal(c.gateway.calls.length, 1);
  } finally { await c.close(); }
});

test('B2 subscription ALL / ANY and unavailable rights are not interpreted as a violation', async () => {
  const c = await context();
  try {
    await c.policy.approveChat(OWNER, CH1, ['verification']);
    await c.policy.approveChat(OWNER, CH2, ['verification']);
    await c.subscription.configure(OWNER, GROUP, [CH1, CH2], 'ALL');
    c.members.set(CH1, MEMBER, 'MEMBER'); c.members.set(CH2, MEMBER, 'NOT_MEMBER');
    assert.equal((await c.subscription.verify(GROUP, MEMBER)).status, 'NOT_MEMBER');
    await c.subscription.configure(OWNER, GROUP, [CH1, CH2], 'ANY');
    assert.equal((await c.subscription.verify(GROUP, MEMBER)).status, 'MEMBER');
    c.members.set(CH1, MEMBER, 'UNKNOWN');
    assert.equal((await c.subscription.verify(GROUP, MEMBER)).status, 'UNAVAILABLE');
    c.members.set(CH1, MEMBER, 'NOT_MEMBER');
    assert.equal((await c.subscription.verify(GROUP, MEMBER)).status, 'NOT_MEMBER');
    assert.equal(c.gateway.calls.length, 0); // verification isn't an automatic punishment
  } finally { await c.close(); }
});

test('B2 cannot require unapproved channel; unknown membership never auto-punishes; verification can clear only subscription reason', async () => {
  const c = await context();
  try {
    await assert.rejects(c.subscription.configure(OWNER, GROUP, [CH1], 'ALL'), /CHANNEL_NOT_APPROVED/);
    await c.policy.approveChat(OWNER, CH1, ['verification']);
    await c.subscription.configure(OWNER, GROUP, [CH1], 'ALL');
    c.members.set(CH1, MEMBER, 'UNKNOWN');
    assert.equal((await c.subscription.syncSubscriptionRestriction(GROUP, MEMBER)).status, 'UNAVAILABLE');
    assert.equal(c.gateway.calls.length, 0);
    c.members.set(CH1, MEMBER, 'NOT_MEMBER');
    assert.equal((await c.subscription.syncSubscriptionRestriction(GROUP, MEMBER)).status, 'APPLIED');
    await c.moderation.addManualReason(OWNER, GROUP, MEMBER, 'manual', 'MUTE');
    c.members.set(CH1, MEMBER, 'MEMBER');
    assert.equal((await c.subscription.syncSubscriptionRestriction(GROUP, MEMBER)).status, 'NO_CHANGE');
    assert.equal(c.moderation.effective(await c.store.snapshot(), GROUP, MEMBER), 'MUTE');
    assert.deepEqual(c.gateway.calls.map(x => x.kind), ['MUTE']);
  } finally { await c.close(); }
});

test('B2 fails closed when channel verification rights are missing', async () => {
  const c = await context();
  try {
    await c.policy.approveChat(OWNER, CH1, ['verification']);
    await c.subscription.configure(OWNER, GROUP, [CH1], 'ALL');
    c.members.set(CH1, MEMBER, 'MEMBER');
    c.members.verifiable = false;
    assert.equal((await c.subscription.verify(GROUP, MEMBER)).status, 'UNAVAILABLE');
  } finally { await c.close(); }
});

test('B2 reads B1 file without losing B1 grants and refuses corrupt unknown schemas', async () => {
  const c = await context();
  try {
    const original = await c.store.snapshot();
    const legacy = { ...original, schemaVersion: 1 } as Record<string, unknown>;
    delete legacy.moderationReasons; delete legacy.moderationOperations; delete legacy.subscriptionRequirements;
    await writeFile(c.file, JSON.stringify(legacy));
    const upgraded = await new BotStore(c.file).snapshot();
    assert.equal(upgraded.schemaVersion, 3);
    assert.equal(upgraded.chats.length, original.chats.length);
    assert.deepEqual(upgraded.moderationReasons, []);
    assert.deepEqual(upgraded.subscriptionRequirements, []);
    await writeFile(c.file, JSON.stringify({ ...legacy, schemaVersion: 999 }));
    await assert.rejects(new BotStore(c.file).snapshot(), /Unsupported state schema/);
  } finally { await c.close(); }
});

test('B2 pipeline never trusts incoming subscriptionVerified flags; gate decides from approved channels', async () => {
  const c = await context();
  try {
    const { UpdatePipeline } = await import('../src/pipeline.js');
    const { CallbackActionCodec } = await import('../src/callback.js');
    const { FakeTelegramGateway } = await import('../src/pipeline.js');
    await c.policy.approveChat(OWNER, CH1, ['verification']);
    await c.subscription.configure(OWNER, GROUP, [CH1], 'ALL');
    await c.policy.configureGroupAI(OWNER, GROUP, 'ALL_MENTION');
    const pipe = new UpdatePipeline(c.store, c.policy, new FakeTelegramGateway(), new CallbackActionCodec(c.store, () => 1_000), () => 1_000, c.subscription);
    const update = { botId: 'b2', kind: 'message' as const, chatKind: 'group' as const, chatId: GROUP, actorId: MEMBER, mentionTarget: 'bot', subscriptionVerified: true };
    c.members.set(CH1, MEMBER, 'NOT_MEMBER');
    assert.equal((await pipe.handle({ ...update, updateId: 1 })).reason, 'SUBSCRIPTION_REQUIRED');
    c.members.set(CH1, MEMBER, 'UNKNOWN');
    assert.equal((await pipe.handle({ ...update, updateId: 2 })).reason, 'SUBSCRIPTION_UNAVAILABLE');
    c.members.set(CH1, MEMBER, 'MEMBER');
    assert.equal((await pipe.handle({ ...update, updateId: 3 })).reason, 'AI_NOT_CONFIGURED');
  } finally { await c.close(); }
});

test('B2 pipeline fails closed if subscription gate is absent and group has a requirement', async () => {
  const c = await context();
  try {
    const { UpdatePipeline, FakeTelegramGateway } = await import('../src/pipeline.js');
    const { CallbackActionCodec } = await import('../src/callback.js');
    await c.policy.approveChat(OWNER, CH1, ['verification']);
    await c.subscription.configure(OWNER, GROUP, [CH1], 'ALL');
    await c.policy.configureGroupAI(OWNER, GROUP, 'ALL_MENTION');
    const pipe = new UpdatePipeline(c.store, c.policy, new FakeTelegramGateway(), new CallbackActionCodec(c.store, () => 1_000), () => 1_000);
    const r = await pipe.handle({ botId: 'b2', updateId: 20, kind: 'message', chatKind: 'group', chatId: GROUP, actorId: MEMBER, mentionTarget: 'bot', subscriptionVerified: true });
    assert.equal(r.reason, 'SUBSCRIPTION_UNAVAILABLE');
  } finally { await c.close(); }
});

test('B2 MOD-003 warning ledger is scoped, immutable by reference, and revocation changes the count only for that case', async () => {
  const c = await context();
  try {
    assert.equal((await c.moderation.issueWarning(STAFF, GROUP, MEMBER, 'case-A')).status, 'DENIED');
    await c.policy.grant(OWNER, STAFF, 'chat.manage', GROUP, 2_000);
    assert.deepEqual(await c.moderation.issueWarning(STAFF, GROUP, MEMBER, 'case-A'), { status: 'ADDED', count: 1 });
    assert.deepEqual(await c.moderation.issueWarning(STAFF, GROUP, MEMBER, 'case-A'), { status: 'NO_CHANGE', count: 1 });
    assert.deepEqual(await c.moderation.issueWarning(STAFF, GROUP, MEMBER, 'case-B'), { status: 'ADDED', count: 2 });
    assert.deepEqual(await c.moderation.removeWarning(OWNER, GROUP, MEMBER, 'case-A'), { status: 'REVOKED', count: 1 });
    assert.deepEqual(await c.moderation.removeWarning(OWNER, GROUP, MEMBER, 'case-A'), { status: 'NO_CHANGE', count: 1 });
    assert.equal((await c.moderation.issueWarning(OWNER, GROUP, OWNER, 'not-allowed')).status, 'DENIED');
    assert.equal(c.gateway.calls.length, 0);
  } finally { await c.close(); }
});
