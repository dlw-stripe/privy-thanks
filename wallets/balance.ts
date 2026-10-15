import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  type Address,
} from "viem";
import { tempoModerato } from "viem/chains";

export const client = createPublicClient({
  chain: tempoModerato,
  transport: http(),
});

export const ousdAddress = "0x20c0000000000000000000006a37da5c996874be" as const;

export async function getOusdBalance(walletAddress: Address) {
  const [rawBalance, decimals] = await Promise.all([
    client.readContract({
      address: ousdAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
    client.readContract({
      address: ousdAddress,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);

  return {
    rawBalance,
    formattedBalance: formatUnits(rawBalance, decimals),
  };
}
