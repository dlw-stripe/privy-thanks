import type {PrivyClient} from '@privy-io/node';
import {OnboardingError} from './types';

/** Delete the linked user; an already-deleted user is a successful reset. */
export async function deleteResetUser({privy, userId}: {privy: PrivyClient; userId: string}) {
  try {
    await privy.users().delete(userId, {timeout: 10_000, maxRetries: 0});
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) return;
    // Keep the saved target after timeouts or API failures so an explicit retry uses the same user.
    throw new OnboardingError(502, 'Couldn’t confirm deletion in Privy. Run /tip reset again to finish.');
  }
}
