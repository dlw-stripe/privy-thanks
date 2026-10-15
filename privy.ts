import { PrivyClient, type AuthorizationContext } from "@privy-io/node";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const privy = new PrivyClient({
  appId: requiredEnv("PRIVY_APP_ID"),
  appSecret: requiredEnv("PRIVY_APP_SECRET"),
});

export const walletOwnerId = requiredEnv("PRIVY_WALLET_OWNER_ID");

export const authorizationContext: AuthorizationContext = {
  authorization_private_keys: [requiredEnv("PRIVY_AUTHORIZATION_PRIVATE_KEY")],
};
