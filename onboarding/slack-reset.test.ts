import assert from 'node:assert/strict';
import {createHmac, randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {PrivyClient} from '@privy-io/node';
import {App} from '@slack/bolt';
import {createUiReceiver} from '../ui/server';
import {deleteResetUser} from './delete-user';
import {handleReset} from './slack-reset';
import {OnboardingStore} from './store';
import type {SlackIdentity, VerifiedWallet} from './types';

function newIdentity(): SlackIdentity {
  return {workspaceId: `T${randomBytes(6).toString('hex')}`, userId: `U${randomBytes(6).toString('hex')}`, name: randomUUID()};
}

function newWallet(): VerifiedWallet {
  return {privyUserId: `did:privy:${randomUUID()}`, walletId: randomUUID(),
    address: `0x${randomBytes(20).toString('hex')}`, email: `${randomUUID()}@example.test`, hasBotSigner: true};
}

function linkWallet(store: OnboardingStore, identity: SlackIdentity, wallet = newWallet()) {
  const token = store.issueLink(identity);
  store.prepareLink(token, wallet);
  store.completeLink(token, wallet);
  return {token, wallet};
}

async function createResetFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tip-reset-'));
  const dbPath = join(directory, 'state.sqlite');
  let store = new OnboardingStore(dbPath);
  const signingSecret = randomBytes(32).toString('hex');
  const deletedUserIds: string[] = [];
  const deletionStatuses: Array<number | 'network-error'> = [];
  const busyWallets = new Set<string>();
  let beforeDelete: (() => Promise<void>) | undefined;
  const appId = randomUUID();
  const privy = new PrivyClient({appId, appSecret: randomUUID(), fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(init?.method, 'DELETE');
    const path = decodeURIComponent(url.pathname);
    assert.match(path, /\/users\/did:privy:/);
    deletedUserIds.push(path.slice(path.lastIndexOf('/') + 1));
    await beforeDelete?.();
    const status = deletionStatuses.shift() ?? 204;
    if (status === 'network-error') throw new TypeError('private upstream diagnostic');
    return status === 204 ? new Response(null, {status}) : Response.json({error: 'private upstream diagnostic'}, {status});
  }});
  const receiver = createUiReceiver({signingSecret});
  const app = new App({receiver, authorize: async () => ({botToken: randomUUID(), botId: 'BTEST', botUserId: 'UTEST'})});
  const replies = new Map<string, (reply: {text: string; responseType?: string}) => void>();
  app.command('/tip', async ({ack, command}) => {
    await ack();
    await handleReset({command, store,
      deleteUser: userId => deleteResetUser({privy, userId}),
      isWalletBusy: walletId => busyWallets.has(walletId),
      respond: async message => {
        replies.get(command.trigger_id)?.({text: typeof message === 'string' ? message : message.text ?? '',
          responseType: typeof message === 'string' ? undefined : message.response_type});
        replies.delete(command.trigger_id);
        return new Response(null, {status: 200});
      },
    });
  });
  const server = await app.start({host: '127.0.0.1', port: 0});
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const commandUrl = `http://127.0.0.1:${address.port}/slack/events`;
  t.after(async () => { await app.stop(); store.close(); await rm(directory, {recursive: true, force: true}); });

  async function command(identity: SlackIdentity, {text = 'reset', signed = true} = {}) {
    const triggerId = randomUUID();
    const reply = new Promise<{text: string; responseType?: string}>(resolve => replies.set(triggerId, resolve));
    const body = new URLSearchParams({command: '/tip', text, team_id: identity.workspaceId,
      user_id: identity.userId, user_name: identity.name, channel_id: randomUUID(), trigger_id: triggerId,
      api_app_id: randomUUID()}).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex');
    const response = await fetch(commandUrl, {method: 'POST', body,
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signed ? `v0=${signature}` : 'v0=invalid'},
    });
    if (response.status !== 200) replies.delete(triggerId);
    return {status: response.status, reply};
  }

  return {get store() { return store; }, deletedUserIds, deletionStatuses, busyWallets, command,
    beforeDelete: (callback: () => Promise<void>) => { beforeDelete = callback; },
    reopenStore: () => { store.close(); store = new OnboardingStore(dbPath); },
  };
}

test('a signed reset deletes only the caller, clears their links, and permits a fresh onboarding', async t => {
  const fixture = await createResetFixture(t);
  const caller = newIdentity();
  const coworker = {...newIdentity(), workspaceId: caller.workspaceId};
  const otherWorkspace = {...caller, workspaceId: newIdentity().workspaceId};
  const demo = newWallet();
  fixture.store.importLegacy({workspaceId: caller.workspaceId, participants: [{name: randomUUID(), alias: 'demo',
    slackUserId: null, email: null, walletId: demo.walletId, address: demo.address}]});
  const linked = linkWallet(fixture.store, caller);
  const other = linkWallet(fixture.store, coworker);
  const elsewhere = linkWallet(fixture.store, otherWorkspace);

  const result = await fixture.command(caller);
  assert.equal(result.status, 200);
  const reply = await result.reply;
  assert.equal(reply.responseType, 'ephemeral');
  assert.match(reply.text, /Reset complete/);
  assert.deepEqual(fixture.deletedUserIds, [linked.wallet.privyUserId]);
  assert.equal(fixture.store.getParticipant(caller), undefined);
  assert.equal(fixture.store.getPendingReset(caller), undefined);
  assert.throws(() => fixture.store.checkLink(linked.token), {status: 410});
  assert.equal(fixture.store.getParticipant(coworker)?.walletId, other.wallet.walletId);
  assert.equal(fixture.store.getParticipant(otherWorkspace)?.walletId, elsewhere.wallet.walletId);
  assert.equal(fixture.store.getParticipantByAlias({workspaceId: caller.workspaceId, alias: 'demo'})?.walletId, demo.walletId);
  fixture.store.checkLink(other.token);
  fixture.reopenStore();
  assert.equal(fixture.store.getParticipant(caller), undefined);
  const fresh = linkWallet(fixture.store, caller);
  assert.equal(fixture.store.getParticipant(caller)?.privyUserId, fresh.wallet.privyUserId);
});

test('an invalid Slack signature or another-user argument cannot trigger deletion', async t => {
  const fixture = await createResetFixture(t);
  const caller = newIdentity();
  const linked = linkWallet(fixture.store, caller);
  assert.equal((await fixture.command(caller, {signed: false})).status, 401);
  const targeted = await fixture.command(caller, {text: `reset <@${newIdentity().userId}>`});
  assert.match((await targeted.reply).text, /Usage: \/tip reset/);
  assert.deepEqual(fixture.deletedUserIds, []);
  assert.equal(fixture.store.getParticipant(caller)?.walletId, linked.wallet.walletId);
});

test('a busy wallet cannot reset and missing mappings clear only pending local links', async t => {
  const fixture = await createResetFixture(t);
  const caller = newIdentity();
  const linked = linkWallet(fixture.store, caller);
  fixture.busyWallets.add(linked.wallet.walletId);
  const busy = await fixture.command(caller);
  assert.match((await busy.reply).text, /tip in progress/);
  assert.equal(fixture.store.getPendingReset(caller), undefined);
  fixture.store.checkLink(linked.token);
  assert.deepEqual(fixture.deletedUserIds, []);

  const unlinked = newIdentity();
  const token = fixture.store.issueLink(unlinked);
  const result = await fixture.command(unlinked);
  assert.match((await result.reply).text, /Reset complete/);
  assert.throws(() => fixture.store.checkLink(token), {status: 410});
  assert.deepEqual(fixture.deletedUserIds, []);
});

for (const failure of [401, 503, 'network-error'] as const) {
  test(`a ${failure} deletion failure keeps its target across restarts, then an already-deleted user completes reset`, async t => {
    const fixture = await createResetFixture(t);
    const caller = newIdentity();
    const linked = linkWallet(fixture.store, caller);
    fixture.deletionStatuses.push(failure, 404);
    const failed = await fixture.command(caller);
    const reply = await failed.reply;
    assert.match(reply.text, /Couldn’t confirm deletion/);
    assert.doesNotMatch(reply.text, /private upstream diagnostic/);
    assert.equal(fixture.store.getPendingReset(caller)?.privyUserId, linked.wallet.privyUserId);
    assert.equal(fixture.store.getParticipant(caller), undefined);
    assert.throws(() => fixture.store.issueLink(caller), {status: 409});
    assert.throws(() => fixture.store.completeLink(linked.token, linked.wallet), {status: 410});
    fixture.reopenStore();
    const retry = await fixture.command(caller);
    assert.match((await retry.reply).text, /Reset complete/);
    assert.deepEqual(fixture.deletedUserIds, [linked.wallet.privyUserId, linked.wallet.privyUserId]);
    assert.equal(fixture.store.getPendingReset(caller), undefined);
    assert.equal(fixture.store.getParticipant(caller), undefined);
    linkWallet(fixture.store, caller);
  });
}

test('overlapping resets make one deletion request and stale completion cannot remove a fresh link', async t => {
  const fixture = await createResetFixture(t);
  const caller = newIdentity();
  linkWallet(fixture.store, caller);
  let signalStarted!: () => void;
  let releaseDeletion!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseDeletion = resolve; });
  t.after(() => releaseDeletion());
  fixture.beforeDelete(async () => { signalStarted(); await gate; });
  const first = await fixture.command(caller);
  await started;
  const saved = fixture.store.getPendingReset(caller)!;
  const second = await fixture.command(caller);
  assert.match((await second.reply).text, /already in progress/);
  assert.equal(fixture.deletedUserIds.length, 1);
  releaseDeletion();
  assert.match((await first.reply).text, /Reset complete/);
  const fresh = linkWallet(fixture.store, caller);
  fixture.store.finishReset({...caller, operationId: saved.operationId});
  assert.equal(fixture.store.getParticipant(caller)?.walletId, fresh.wallet.walletId);
});
