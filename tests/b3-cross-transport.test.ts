import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { EducationService } from '../src/education.js';
import { EducationAdminFacade } from '../src/education-admin.js';
import { ApprovedAnswerService, ResourceLinkService } from '../src/education-interactions.js';
import { TelegramUpdateApplication, telegramWebhookListener } from '../src/telegram-transport.js';
import { TelegramMiniAppAuth, telegramAdminWebListener } from '../src/web-admin-auth.js';

const NOW = 1_800_000_000_000;
const OWNER = '100', STUDENT = '200', GROUP = '-100123';
const WEBHOOK_SECRET = 'FAKE_LOCAL_WEBHOOK_SECRET_012345678901';
const FAKE_BOT_TOKEN = '999999:FAKE_NO_REAL_TELEGRAM_TOKEN_12345678901234567890';
const csv = 'title,university,cycle\nScholarship & <Example>,University A,2027';
const bytes = new TextEncoder().encode(csv);

function signedInitData(actorId: number): string {
  const fields = new URLSearchParams({
    auth_date: String(NOW / 1000), user: JSON.stringify({ id: actorId, first_name: 'Demo' }),
  });
  const data = Array.from(fields.entries()).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(FAKE_BOT_TOKEN).digest();
  fields.append('hash', createHmac('sha256', key).update(data).digest('hex'));
  return fields.toString();
}
async function withLocalServer(listener: RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('INVALID_ADDRESS');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('B3 cross-transport flow: Telegram document -> signed web review -> scoped student browsing, never Telegram delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manaratak-cross-transport-'));
  const store = new BotStore(join(dir, 'state.json'));
  const policy = new Policy(store, OWNER, () => NOW);
  const education = new EducationService(store, policy, () => NOW);
  const admin = new EducationAdminFacade(store, policy, education, () => NOW);
  const faq = new ApprovedAnswerService(store, policy, () => NOW);
  const links = new ResourceLinkService(store, policy, () => NOW);
  let downloaded = 0;
  const app = new TelegramUpdateApplication({
    store, policy, education, admin, faq, links, botId: 'bot-1', botUsername: 'ManaratakBot',
    clock: () => NOW, membership: async () => 'VERIFIED',
    documentDownload: { async download(_fileId, maxBytes) {
      downloaded++;
      assert.equal(maxBytes, 256 * 1024);
      return bytes;
    } },
  });
  try {
    await policy.approveChat(OWNER, GROUP, ['navigation']);
    await education.createCategory(OWNER, { id: 'grants', scope: GROUP, title: 'المنح', order: 1 });
    const telegramDocument = {
      update_id: 10001,
      message: {
        chat: { id: Number(OWNER), type: 'private' }, from: { id: Number(OWNER), is_bot: false },
        caption: `/upload ${GROUP}`,
        document: {
          file_id: 'AAEvalidTelegramFileID000000', file_name: 'offers.csv', file_size: bytes.length, mime_type: 'text/csv',
        },
      },
    };
    await withLocalServer(telegramWebhookListener(app, WEBHOOK_SECRET), async (url) => {
      const request = () => fetch(`${url}/telegram/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        body: JSON.stringify(telegramDocument),
      });
      const first = await request();
      assert.deepEqual(await first.json(), { ok: true, status: 'APPLIED' });
      const retry = await request();
      assert.deepEqual(await retry.json(), { ok: true, status: 'DUPLICATE' });
    });
    assert.equal(downloaded, 1);
    let snap = await store.snapshot();
    assert.equal(snap.importRuns.length, 1);
    assert.equal(snap.educationResources.length, 0, 'a Telegram upload never publishes automatically');
    const importId = snap.importRuns[0]!.id;

    const auth = new TelegramMiniAppAuth(FAKE_BOT_TOKEN, () => NOW, 600);
    await withLocalServer(telegramAdminWebListener(auth, admin), async (url) => {
      const invoke = async (path: string, actorId: number, body: unknown) => {
        const res = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-init-data': signedInitData(actorId) },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };
      const fields = { importId, index: 0, categoryId: 'grants' };
      assert.equal((await invoke('/admin/approve', Number(STUDENT), fields)).status, 403,
        'an unrelated student cannot approve by guessing an import ID');
      assert.equal((await invoke('/admin/publish', Number(OWNER), fields)).status, 422,
        'publishing without approval must fail');
      assert.equal((await invoke('/admin/approve', Number(OWNER), fields)).status, 200);
      assert.equal((await invoke('/admin/publish', Number(OWNER), fields)).status, 200);
    });
    snap = await store.snapshot();
    assert.equal(snap.educationResources.length, 1);
    const message = (updateId: number) => ({
      update_id: updateId, message: { chat: { id: Number(GROUP), type: 'supergroup' },
        from: { id: Number(STUDENT), is_bot: false }, text: '/resources grants' },
    });
    const shown = await app.handle(message(10002));
    assert.equal(shown.status, 'APPLIED');
    assert.match(shown.plan?.text ?? '', /Scholarship &amp; &lt;Example&gt;/,
      'the output plan must escape untrusted imported content');
    assert.equal(shown.plan?.chatId, GROUP);
    await policy.revokeChat(OWNER, GROUP);
    const revoked = await app.handle(message(10003));
    assert.equal(revoked.status, 'DENIED');
    assert.equal(revoked.plan, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
