import assert from 'node:assert/strict';
import {createHmac, randomBytes} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {App} from '@slack/bolt';
import {createUiReceiver} from './server';

test('UI routing preserves Slack signature verification', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'privy-thanks-ui-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<h1>Privy thanks</h1>');
  await writeFile(join(directory, 'assets', 'main.js'), 'console.log("UI loaded");');
  await writeFile(join(directory, '.env'), 'PRIVATE_CONFIGURATION');

  const signingSecret = randomBytes(32).toString('hex');
  const receiver = createUiReceiver({signingSecret, frontendDirectory: directory});
  const app = new App({
    receiver,
    authorize: async () => ({botToken: 'test-token', botId: 'BTEST', botUserId: 'UTEST'}),
  });
  let handledCommands = 0;
  app.command('/tip', async ({ack}) => {
    handledCommands += 1;
    await ack({text: 'Accepted'});
  });
  const server = await app.start({port: 0, host: '127.0.0.1'});
  t.after(() => app.stop());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${origin}/login`);
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.match(await login.text(), /Privy thanks/);

  const asset = await fetch(`${origin}/assets/main.js`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /UI loaded/);

  for (const path of ['/.env', '/participants.yaml', '/assets/.env', '/src/main.tsx', '/slack/unknown']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /PRIVATE_CONFIGURATION/);
  }

  const body = new URLSearchParams({
    command: '/tip', text: 'balance', team_id: 'TTEST', user_id: 'UTEST',
    channel_id: 'CTEST', trigger_id: 'test-trigger', api_app_id: 'ATEST',
  }).toString();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': timestamp,
  };

  const unsigned = await fetch(`${origin}/slack/events`, {method: 'POST', headers, body});
  assert.equal(unsigned.status, 401);
  const tampered = await fetch(`${origin}/slack/events`, {
    method: 'POST', headers: {...headers, 'x-slack-signature': 'v0=invalid'}, body,
  });
  assert.equal(tampered.status, 401);
  assert.equal(handledCommands, 0);

  const signature = createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex');
  const signed = await fetch(`${origin}/slack/events`, {
    method: 'POST', headers: {...headers, 'x-slack-signature': `v0=${signature}`}, body,
  });
  assert.equal(signed.status, 200);
  assert.deepEqual(await signed.json(), {text: 'Accepted'});
  assert.equal(handledCommands, 1);
});
