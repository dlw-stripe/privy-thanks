import {
  encodeFunctionData,
  erc20Abi,
  parseUnits,
  type Address,
  type Hash,
} from "viem";

import { ousdAddress } from "./balance";
import { authorizationContext, privy } from "../privy";

export async function sendOusd({
  senderWalletId,
  recipientAddress,
  amount,
}: {
  senderWalletId: string;
  recipientAddress: Address;
  amount: string;
}) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) {
    throw new Error("Amount must have at most six decimal places.");
  }

  const tokenAmount = parseUnits(amount, 6);

  if (tokenAmount <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipientAddress, tokenAmount],
  });

  const { hash } = await privy.wallets().ethereum().sendTransaction(
    senderWalletId,
    {
      caip2: "eip155:42431",
      params: {
        transaction: {
          type: 118,
          calls: [{ to: ousdAddress, data }],
        },
      },
      sponsor: true,
      authorization_context: authorizationContext,
    },
  );

  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('Privy did not return a valid transaction hash.');
  }

  return {
    hash: hash as Hash,
    explorerUrl: `https://explore.testnet.tempo.xyz/tx/${hash}`,
  };
}
