import assert from 'node:assert/strict';
import {createHmac, generateKeyPairSync, randomBytes, randomUUID, sign} from 'node:crypto';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {PrivyClient} from '@privy-io/node';
import {App} from '@slack/bolt';
import {createUiReceiver} from '../ui/server';
import {OnboardingStore} from './store';
import {verifyOnboardingWallet} from './verify-wallet';
import {handleLogin} from './slack-login';

test('Slack linking verifies real JWTs, wallet ownership, and signer access before persisting routing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tip-link-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const dbPath = join(directory, 'participants.sqlite');
  let now = Date.now();
  const store = new OnboardingStore(dbPath, () => now);
  t.after(() => store.close());
  const identity = {workspaceId: `T${randomBytes(6).toString('hex')}`, userId: `U${randomBytes(6).toString('hex')}`, name: randomUUID()};
  const appId = randomUUID();
  const userId = `did:privy:${randomUUID()}`;
  const walletId = randomUUID();
  const address = `0x${randomBytes(20).toString('hex')}` as const;
  const signerId = randomUUID();
  const ownerId = randomUUID();
  const email = `${randomUUID()}@example.test`;
  const legacy = {name: identity.name, slackUserId: identity.userId, email: null,
    walletId: randomUUID(), address: `0x${randomBytes(20).toString('hex')}` as const};
  const demo = {...legacy, alias: 'demo', slackUserId: null, walletId: randomUUID(), address: `0x${randomBytes(20).toString('hex')}` as const};
  store.importLegacy({workspaceId: identity.workspaceId, participants: [legacy, demo]});

  const keys = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const user = {id: userId, linked_accounts: [
    {type: 'google_oauth', email},
    {type: 'wallet', id: walletId, address, chain_type: 'ethereum', wallet_client_type: 'privy', connector_type: 'embedded', delegated: true},
  ]};
  const wallet = {id: walletId, address, chain_type: 'ethereum', owner_id: ownerId,
    additional_signers: [{signer_id: randomUUID()}]};
  let ownerUsers = [userId];
  let externalCalls = 0;
  // Mock only Privy's HTTP boundary. JWT verification, routes, and SQLite are real.
  const privy = new PrivyClient({appId, appSecret: randomUUID(),
    jwtVerificationKey: keys.publicKey.export({format: 'pem', type: 'spki'}).toString(),
    fetch: async (input) => {
      externalCalls += 1;
      const path = new URL(String(input)).pathname;
      if (path.endsWith(`/users/${userId}`)) return Response.json(user);
      if (path.endsWith(`/wallets/${walletId}`)) return Response.json(wallet);
      if (path.endsWith(`/key_quorums/${ownerId}`)) return Response.json({id: ownerId, user_ids: ownerUsers});
      throw new Error(`Unexpected test API path: ${path}`);
    },
  });
  function token({audience = appId, expiration = Math.floor(Date.now() / 1000) + 600} = {}) {
    const header = Buffer.from(JSON.stringify({alg: 'ES256', typ: 'JWT'})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({aud: audience, iss: 'privy.io', sub: userId,
      sid: randomUUID(), iat: Math.floor(Date.now() / 1000), exp: expiration})).toString('base64url');
    const signingInput = `${header}.${payload}`;
    return `${signingInput}.${sign('sha256', Buffer.from(signingInput), {key: keys.privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64url')}`;
  }
  const publicOrigin = 'https://tip.example.test';
  const signingSecret = randomUUID();
  const receiver = createUiReceiver({signingSecret, onboarding: {
    store, publicOrigin, signerId,
    verifyWallet: input => verifyOnboardingWallet({privy, ...input, signerId}),
  }});
  const app = new App({receiver, authorize: async () => ({botToken: randomUUID(), botId: 'BTEST', botUserId: 'UTEST'})});
  let privateReply: Record<string, unknown> | undefined;
  app.command('/tip', async ({ack, command}) => {
    await ack();
    await handleLogin({command, publicOrigin, store, respond: async message => {
      privateReply = typeof message === 'string' ? {text: message} : {...message};
      return new Response(null, {status: 200});
    }});
  });
  const server = await app.start({host: '127.0.0.1', port: 0});
  t.after(() => app.stop());
  const serverAddress = server.address();
  assert.ok(serverAddress && typeof serverAddress !== 'string');
  const url = `http://127.0.0.1:${serverAddress.port}/api/slack-link`;
  const commandBody = new URLSearchParams({command: '/tip', text: 'login',
    team_id: identity.workspaceId, user_id: identity.userId, user_name: identity.name,
    channel_id: randomUUID(), trigger_id: randomUUID(), api_app_id: randomUUID()}).toString();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', signingSecret).update(`v0:${timestamp}:${commandBody}`).digest('hex');
  const loginCommand = await fetch(url.replace('/api/slack-link', '/slack/events'), {
    method: 'POST', body: commandBody, headers: {'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${signature}`},
  });
  assert.equal(loginCommand.status, 200);
  assert.equal(privateReply?.response_type, 'ephemeral');
  const linkToken = /#link=([a-f0-9]{64})/.exec(String(privateReply?.text))?.[1];
  assert.ok(linkToken, 'the signed Slack command issues a private link');
  async function post({action = 'prepare', bearer = token(), origin = publicOrigin,
    capability = linkToken, walletAddress = address, extra = {}} = {}) {
    const response = await fetch(url, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin, Authorization: `Bearer ${bearer}`},
      body: JSON.stringify({action, linkToken: capability, walletAddress, ...extra}),
    });
    const body = await response.json() as Record<string, unknown>;
    return {status: response.status, body};
  }

  assert.equal((await post({origin: 'https://elsewhere.example.test'})).status, 403);
  assert.equal((await post({capability: randomBytes(32).toString('hex')})).status, 410);
  assert.equal((await post({bearer: randomUUID()})).status, 401);
  assert.equal((await post({bearer: token({audience: randomUUID()})})).status, 401);
  assert.equal((await post({bearer: token({expiration: 1})})).status, 401);
  assert.equal(externalCalls, 0);
  assert.equal((await post({walletAddress: `0x${randomBytes(20).toString('hex')}`})).status, 403);
  ownerUsers = [randomUUID()];
  assert.equal((await post()).status, 403);
  ownerUsers = [userId];

  const prepared = await post({extra: {workspaceId: randomUUID(), slackUserId: randomUUID()}});
  assert.equal(prepared.status, 200);
  assert.deepEqual(prepared.body, {workspaceId: identity.workspaceId, slackUserId: identity.userId, signerId, hasBotSigner: false, linked: false});
  assert.equal((await post({action: 'complete'})).status, 409);
  assert.equal(store.getParticipant(identity)?.walletId, legacy.walletId);
  wallet.additional_signers.push({signer_id: signerId});
  assert.equal((await post({action: 'complete'})).status, 200);
  assert.deepEqual(store.getParticipant(identity), {name: identity.name, slackUserId: identity.userId,
    alias: undefined, email, walletId, address, privyUserId: userId});
  assert.equal((await post({action: 'complete'})).status, 200, 'a lost success response can be retried');
  assert.equal((await post()).body.hasBotSigner, true);

  const otherLink = store.issueLink({...identity, userId: `U${randomBytes(6).toString('hex')}`});
  assert.equal((await post({capability: otherLink})).status, 409, 'another Slack user cannot claim this wallet');
  const otherWorkspace = {...identity, workspaceId: `T${randomBytes(6).toString('hex')}`};
  const otherWorkspaceLink = store.issueLink(otherWorkspace);
  assert.equal((await post({capability: otherWorkspaceLink})).status, 200);
  assert.equal(store.getParticipant(otherWorkspace), undefined, 'prepare does not change routing');
  now += 16 * 60 * 1000;
  assert.equal((await post({action: 'complete', capability: otherWorkspaceLink})).status, 410);
  const superseded = store.issueLink(otherWorkspace);
  store.issueLink(otherWorkspace);
  assert.equal((await post({capability: superseded})).status, 410);

  const malformed = await fetch(url, {method: 'POST', headers: {Origin: publicOrigin, 'Content-Type': 'application/json'}, body: '{broken'});
  assert.equal(malformed.status, 400);
  const oversized = await fetch(url, {method: 'POST', headers: {Origin: publicOrigin, 'Content-Type': 'application/json'}, body: JSON.stringify({data: 'x'.repeat(5000)})});
  assert.equal(oversized.status, 413);
  assert.doesNotMatch(await readFile(dbPath, 'utf8'), new RegExp(linkToken), 'raw link tokens are never persisted');

  const reopened = new OnboardingStore(dbPath);
  t.after(() => reopened.close());
  reopened.importLegacy({workspaceId: identity.workspaceId, participants: [legacy, demo]});
  assert.equal(reopened.getParticipant(identity)?.walletId, walletId);
  assert.equal(reopened.getParticipantByAlias({workspaceId: identity.workspaceId, alias: 'DEMO'})?.walletId, demo.walletId);
  assert.equal(reopened.getParticipant({...identity, workspaceId: randomUUID()}), undefined);
});
