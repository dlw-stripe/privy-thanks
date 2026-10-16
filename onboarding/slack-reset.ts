import type {RespondFn, SlashCommand} from '@slack/bolt';
import type {OnboardingStore} from './store';
import {OnboardingError} from './types';

const resetsInProgress = new Set<string>();

/** Reset only the account identified by Slack's verified command payload. */
export async function handleReset({command, respond, store, deleteUser, isWalletBusy}: {
  command: SlashCommand;
  respond: RespondFn;
  store: OnboardingStore;
  deleteUser: (userId: string) => Promise<void>;
  isWalletBusy: (walletId: string) => boolean;
}) {
  const reply = (text: string) => respond({response_type: 'ephemeral', text});
  if (command.text.trim() !== 'reset') {
    await reply('Usage: /tip reset. This resets only your own linked account.');
    return;
  }
  const identity = {workspaceId: command.team_id, userId: command.user_id};
  const key = `${identity.workspaceId}:${identity.userId}`;
  if (resetsInProgress.has(key)) {
    await reply('Your reset is already in progress.');
    return;
  }
  resetsInProgress.add(key);
  try {
    const pending = store.getPendingReset(identity);
    const participant = store.getParticipant(identity);
    const walletId = pending?.walletId ?? participant?.walletId;
    if (walletId && isWalletBusy(walletId)) {
      await reply('This wallet has a tip in progress or awaiting verification. Resolve that tip before resetting.');
      return;
    }
    const reset = store.beginReset(identity);
    if (reset.privyUserId) {
      try {
        await deleteUser(reset.privyUserId);
      } catch (error) {
        console.error('Privy user reset did not confirm deletion.');
        await reply(error instanceof OnboardingError ? error.message : 'Reset is pending. Run /tip reset again to finish.');
        return;
      }
    }
    store.finishReset({...identity, operationId: reset.operationId});
    await reply(reset.privyUserId
      ? 'Reset complete. Log out of the login page, then run /tip login to start again.'
      : 'Reset complete. No linked Privy user was found. Log out of the login page, then run /tip login.');
  } finally {
    resetsInProgress.delete(key);
  }
}
