import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { PublicationService, FakePublicationGateway } from '../src/publishing.js';
import { CampaignMultipartService } from '../src/campaign-multipart.js';
import { planPublicationPreview } from '../src/publication-preview-plan.js';

const OWNER = '100', SOURCE = '-100', DEST = '-200';
const LONG_TEXT = 'منحة موثقة — شروط ومعلومات مراجعة. '.repeat(240);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'b4-reviewed-parts-'));
  const file = join(dir, 'state.json'), store = new BotStore(file);
  const clock = () => 1000, policy = new Policy(store, OWNER, clock);
  const education = new EducationService(store, policy, clock);
  const gateway = new FakePublicationGateway();
  const publication = () => new PublicationService(new BotStore(file), new Policy(new BotStore(file), OWNER, clock), gateway, clock);
  const partService = () => new CampaignMultipartService(new BotStore(file), new Policy(new BotStore(file), OWNER, clock), {
    canPost: destination => gateway.canPost(destination),
    sendPart: request => gateway.send(request.destination, request.part.text, request.attemptId),
    verifyReceipt: receipt => gateway.verifyReceipt(receipt)
  }, clock);
  await policy.approveChat(OWNER, SOURCE, ['navigation']);
  await policy.approveChat(OWNER, DEST, ['publishing']);
  await education.createCategory(OWNER, { id: 'grants', scope: SOURCE, title: 'المنح', order: 1 });
  const run = await education.submitText(OWNER, SOURCE, 'ADMIN_WEB', 'csv', 'approved.csv', 'title,university\nApproved Grant,University A\n');
  await education.approveCandidate(OWNER, run.id, 0, 'grants');
  const resource = await education.publishCandidate(OWNER, run.id, 0, 'grants');
  return { file, dir, store, policy, education, gateway, publication, partService, resource,
    close: () => rm(dir, { recursive: true, force: true }) };
}

test('B4 reviewed flow: published B3 resource -> reviewer text -> draft render plan -> approval reserves one multipart ledger', async () => {
  const f = await fixture(); try {
    await f.education.setPublicationText(OWNER, f.resource.id, LONG_TEXT);
    const c = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
    const plan = planPublicationPreview({ text: LONG_TEXT });
    assert.equal(c.status, 'DRAFT');
    assert.deepEqual(c.previews[0]?.renderPlan, plan);
    assert.ok(plan.parts.length > 1);
    const approved = await f.publication().approve(OWNER, c.id);
    assert.equal(approved.status, 'APPROVED');
    const delivery = (await f.store.snapshot()).deliveries[0]!;
    assert.equal(delivery.status, 'MULTIPART');
    assert.equal(delivery.multipart?.fingerprint, plan.fingerprint);
    assert.deepEqual(delivery.multipart?.parts.map(x => x.payload), plan.parts);
    assert.equal(f.gateway.calls.length, 0);
    await assert.rejects(f.partService().stage(OWNER, c.id, f.resource.id, plan), /ALREADY_STAGED/);
    assert.equal((await f.publication().dispatchNext(c.id)).status, 'SENT');
    const restarted = f.publication();
    for (let i = 1; i < plan.parts.length; i++) assert.equal((await restarted.dispatchNext(c.id)).status, 'SENT');
    assert.equal((await restarted.dispatchNext(c.id)).status, 'EMPTY');
    const finished = await f.store.snapshot();
    assert.equal(finished.campaigns[0]!.status, 'COMPLETED');
    assert.equal(finished.deliveries[0]!.status, 'SENT');
    assert.equal(f.gateway.calls.length, plan.parts.length);
    assert.equal(new Set(finished.deliveries[0]!.multipart!.parts.map(x => x.messageId)).size, plan.parts.length);
  } finally { await f.close(); }
});

test('B4 reviewed flow: crash ambiguity is durable, never retried, and only a provider-verified unique receipt advances', async () => {
  const f = await fixture(); try {
    await f.education.setPublicationText(OWNER, f.resource.id, LONG_TEXT);
    const c = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
    await f.publication().approve(OWNER, c.id);
    f.gateway.throwAfterSend = true;
    assert.equal((await f.publication().dispatchNext(c.id)).status, 'UNKNOWN_OUTCOME');
    const delivery = (await f.store.snapshot()).deliveries[0]!;
    const attempt = delivery.multipart!.parts[0]!.attemptId!;
    assert.equal((await f.publication().recoverPending()), 0);
    assert.equal((await f.publication().dispatchNext(c.id)).status, 'BLOCKED');
    assert.equal(f.gateway.calls.length, 1);
    await assert.rejects(f.partService().reconcileUnknown(OWNER, c.id, f.resource.id, 0,
      { destination: DEST, attemptId: attempt, messageId: 'unverified' }), /RECEIPT_INVALID/);
    const receipt = f.gateway.getReceipt(attempt)!;
    assert.equal((await f.partService().reconcileUnknown(OWNER, c.id, f.resource.id, 0, receipt)).status, 'SENT');
    f.gateway.throwAfterSend = false;
    assert.equal((await f.publication().dispatchNext(c.id)).status, 'SENT');
    assert.equal(f.gateway.calls.length, 2);
  } finally { await f.close(); }
});

test('B4 reviewed flow: policy revocation, archived resource and edited approved text never reach gateway', async () => {
  for (const change of ['chat', 'archive', 'text'] as const) {
    const f = await fixture(); try {
      await f.education.setPublicationText(OWNER, f.resource.id, LONG_TEXT);
      const c = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
      await f.publication().approve(OWNER, c.id);
      if (change === 'chat') await f.policy.revokeChat(OWNER, DEST);
      if (change === 'archive') await f.education.archiveResource(OWNER, f.resource.id);
      if (change === 'text') await f.education.setPublicationText(OWNER, f.resource.id, LONG_TEXT + 'مراجعة جديدة');
      assert.equal((await f.publication().dispatchNext(c.id)).status, 'BLOCKED');
      assert.equal(f.gateway.calls.length, 0);
    } finally { await f.close(); }
  }
});

test('B4 reviewed flow: v5 migration preserves historic deliveries and B3 data', async () => {
  const f = await fixture(); try {
    const c = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
    await f.publication().approve(OWNER, c.id);
    await f.publication().dispatchNext(c.id);
    const historic = await f.store.snapshot();
    await writeFile(f.file, JSON.stringify({ ...historic, schemaVersion: 5 }));
    const migrated = await new BotStore(f.file).snapshot();
    assert.equal(migrated.schemaVersion, 6);
    assert.deepEqual(migrated.deliveries, historic.deliveries);
    assert.deepEqual(migrated.campaigns, historic.campaigns);
    assert.deepEqual(migrated.educationResources, historic.educationResources);
  } finally { await f.close(); }
});

test('B4 reviewed flow: uploader cannot approve publication copy; preview plan tampering cannot be approved', async () => {
  const f = await fixture(); try {
    await f.policy.grant(OWNER, '300', 'content.upload', SOURCE, 20000);
    await assert.rejects(f.education.setPublicationText('300', f.resource.id, LONG_TEXT), /PUBLISH_DENIED/);
    await assert.rejects(f.education.setPublicationText(OWNER, f.resource.id, 'x'.repeat(40961)), /PREVIEW_TOO_LONG/);
    await f.education.setPublicationText(OWNER, f.resource.id, LONG_TEXT);
    const c = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
    await f.store.transaction(s => {
      s.campaigns.find(x => x.id === c.id)!.previews[0]!.renderPlan!.parts[0]!.text = 'forged text';
    });
    await assert.rejects(f.publication().approve(OWNER, c.id), /PREVIEW_STALE/);
    assert.equal((await f.store.snapshot()).deliveries.length, 0);
    assert.equal(f.gateway.calls.length, 0);
  } finally { await f.close(); }
});

test('B4 reviewed flow: persisted attempt precedes async network permission check and approver revocation denies send', async () => {
  const f = await fixture(); try {
    const editor = '201';
    await f.policy.grant(OWNER, editor, 'content.publish', SOURCE, 20000);
    await f.policy.grant(OWNER, editor, 'content.publish', DEST, 20000);
    await f.education.setPublicationText(editor, f.resource.id, LONG_TEXT);
    const c = await f.publication().draft(editor, SOURCE, DEST, [f.resource.id]);
    await f.publication().approve(editor, c.id);
    f.gateway.canPost = async () => {
      const state = await f.store.snapshot();
      const part = state.deliveries[0]!.multipart!.parts[0]!;
      assert.equal(part.status, 'SENDING');
      assert.ok(part.attemptId);
      assert.ok(state.audit.some(a => a.reason === 'PART_ATTEMPT_RECORDED_BEFORE_SEND'));
      await f.policy.revokeGrant(OWNER, editor, 'content.publish', DEST);
      return true;
    };
    assert.equal((await f.publication().dispatchNext(c.id)).status, 'BLOCKED');
    assert.equal(f.gateway.calls.length, 0);
    assert.equal((await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!.status, 'QUEUED');
  } finally { await f.close(); }
});

test('B4 reviewed flow: process restart turns a durable orphaned part attempt into UNKNOWN without resending', async () => {
  const f = await fixture(); try {
    await f.education.setPublicationText(OWNER, f.resource.id, LONG_TEXT);
    const c = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
    await f.publication().approve(OWNER, c.id);
    await f.store.transaction(s => {
      const first = s.deliveries[0]!.multipart!.parts[0]!;
      first.status = 'SENDING';
      first.attemptId = 'existing-attempt';
    });
    assert.equal(await f.publication().recoverPending(), 1);
    assert.equal((await f.publication().dispatchNext(c.id)).status, 'BLOCKED');
    assert.equal(f.gateway.calls.length, 0);
    const pending = (await f.store.snapshot()).deliveries[0]!.multipart!.parts;
    assert.equal(pending[0]!.status, 'UNKNOWN_OUTCOME');
    assert.equal(pending[0]!.attemptId, 'existing-attempt');
    assert.equal(pending[1]!.status, 'QUEUED');
  } finally { await f.close(); }
});

test('B4 reviewed flow: duplicate campaigns share the original resource reservation, never a second multipart ledger', async () => {
  const f = await fixture(); try {
    await f.education.setPublicationText(OWNER, f.resource.id, LONG_TEXT);
    const a = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
    const b = await f.publication().draft(OWNER, SOURCE, DEST, [f.resource.id]);
    await f.publication().approve(OWNER, a.id);
    await assert.rejects(f.publication().approve(OWNER, b.id), /DELIVERY_ALREADY_RESERVED/);
    const snapshot = await f.store.snapshot();
    assert.equal(snapshot.deliveries.length, 1);
    assert.equal(snapshot.deliveries[0]!.status, 'MULTIPART');
    assert.equal(snapshot.deliveries[0]!.multipart!.parts.length, planPublicationPreview({text:LONG_TEXT}).parts.length);
  } finally { await f.close(); }
});
