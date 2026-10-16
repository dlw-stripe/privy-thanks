import type {PrivyClient} from '@privy-io/node';
import {OnboardingError, type VerifiedWallet} from './types';

/** Verify the session, embedded wallet ownership, and this bot's exact signer grant. */
export async function verifyOnboardingWallet({privy, accessToken, address, signerId}: {
  privy: PrivyClient; accessToken: string; address: string; signerId: string;
}): Promise<VerifiedWallet> {
  let claims;
  try {
    // This SDK version accepts a string and returns snake_case claims.
    claims = await privy.utils().auth().verifyAccessToken(accessToken);
  } catch {
    throw new OnboardingError(401, 'Log in again to continue wallet setup.');
  }
  try {
    const user = await privy.users()._get(claims.user_id, {timeout: 10_000, maxRetries: 0});
    const google = user.linked_accounts.find(account => account.type === 'google_oauth');
    const account = user.linked_accounts.find(account =>
      account.type === 'wallet' && account.chain_type === 'ethereum' &&
      account.wallet_client_type === 'privy' && account.connector_type === 'embedded' &&
      account.address.toLowerCase() === address.toLowerCase(),
    );
    if (!google || !google.email || !account || !('id' in account) || !account.id) {
      throw new OnboardingError(403, 'Choose the embedded wallet from the logged-in Google account.');
    }
    const wallet = await privy.wallets().get(account.id, undefined, {timeout: 10_000, maxRetries: 0});
    if (user.id !== claims.user_id || wallet.chain_type !== 'ethereum' ||
        wallet.address.toLowerCase() !== address.toLowerCase() || !wallet.owner_id) {
      throw new OnboardingError(403, 'Wallet ownership could not be verified.');
    }
    const owner = await privy.keyQuorums().get(wallet.owner_id, {timeout: 10_000, maxRetries: 0});
    if (!owner.user_ids?.includes(user.id)) {
      throw new OnboardingError(403, 'Wallet ownership could not be verified.');
    }
    return {
      privyUserId: user.id, walletId: wallet.id, address: wallet.address as `0x${string}`,
      email: google.email, hasBotSigner: wallet.additional_signers.some(signer => signer.signer_id === signerId),
    };
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(502, 'Couldn’t verify the wallet with Privy. Retry wallet setup.');
  }
}
