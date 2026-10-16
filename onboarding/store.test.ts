import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {OnboardingStore} from './store';

test('a prepared or consumed link cannot change accounts, and a linked Slack wallet cannot be replaced', () => {
  const store = new OnboardingStore(':memory:');
  try {
    const identity = {workspaceId: randomUUID(), userId: randomUUID(), name: randomUUID()};
    const wallet = {privyUserId: randomUUID(), walletId: randomUUID(), address: `0x${randomBytes(20).toString('hex')}` as const,
      email: `${randomUUID()}@example.test`, hasBotSigner: true};
    const token = store.issueLink(identity);
    assert.throws(() => store.completeLink(token, wallet), {status: 409});
    store.prepareLink(token, wallet);
    assert.equal(store.getParticipant(identity), undefined);
    assert.throws(() => store.prepareLink(token, {...wallet, privyUserId: randomUUID()}), {status: 409});
    assert.throws(() => store.completeLink(token, {...wallet, walletId: randomUUID()}), {status: 409});
    store.completeLink(token, wallet);
    assert.throws(() => store.completeLink(token, {...wallet, privyUserId: randomUUID()}), {status: 409});
    const newToken = store.issueLink(identity);
    assert.throws(() => store.prepareLink(newToken, {...wallet, privyUserId: randomUUID()}), {status: 409});
    assert.equal(store.getParticipant(identity)?.walletId, wallet.walletId);
  } finally { store.close(); }
});
