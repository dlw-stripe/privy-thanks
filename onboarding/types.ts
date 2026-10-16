/** A wallet that Slack commands can route to. */
export type Participant = {
  alias?: string;
  name: string;
  slackUserId: string | null;
  email: string | null;
  walletId: string;
  address: `0x${string}`;
  privyUserId?: string;
};

/** Slack identity taken only from a signature-verified slash command. */
export type SlackIdentity = {workspaceId: string; userId: string; name: string};

/** Identity and signing authority read from Privy's backend API. */
export type VerifiedWallet = {
  privyUserId: string;
  walletId: string;
  address: `0x${string}`;
  email: string;
  hasBotSigner: boolean;
};

/** A safe message that can be returned by the onboarding API. */
export class OnboardingError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OnboardingError';
  }
}
