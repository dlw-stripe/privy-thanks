import type {PrivyClientConfig} from '@privy-io/react-auth';
import {tempoModerato} from 'viem/chains';

/** Configure Google login and user-owned wallets for the Tempo testnet demo. */
export const privyConfig = {
  loginMethods: ['google'],
  appearance: {
    theme: 'light',
    walletChainType: 'ethereum-only',
  },
  defaultChain: tempoModerato,
  supportedChains: [tempoModerato],
  embeddedWallets: {
    ethereum: {
      createOnLogin: 'users-without-wallets',
    },
  },
} satisfies PrivyClientConfig;
