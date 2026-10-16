import {App, type RespondFn, type SlashCommand} from '@slack/bolt';
import {basename} from 'node:path';
import {createUiReceiver} from './ui/server';
import {formatUnits, parseUnits} from 'viem';
import {EnvHttpProxyAgent, setGlobalDispatcher} from 'undici';
import {getParticipant, getParticipantByAlias, participantStore, type Participant} from './participants';
import {client, getOusdBalance} from './wallets/balance';
import {sendOusd} from './wallets/transfer';
import {privy, walletOwnerId} from './privy';
import {verifyOnboardingWallet} from './onboarding/verify-wallet';
import {handleLogin} from './onboarding/slack-login';
import {handleReset} from './onboarding/slack-reset';
import {deleteResetUser} from './onboarding/delete-user';
import {OnboardingError} from './onboarding/types';

// Route Slack, Privy, and RPC requests through the devbox's outbound proxy.
setGlobalDispatcher(new EnvHttpProxyAgent());

type CommandContext = {command: SlashCommand; respond: RespondFn};
type Balances = Awaited<ReturnType<typeof readBothBalances>>;
const busyWallets = new Set<string>();
// Track both sides so a recipient cannot reset while a tip is being submitted.
const activeTipWallets = new Map<string, number>();
const usage = 'Usage: /tip demo 1 Thanks for helping! or /tip @coworker 1 Thanks for helping!';

export function escapeSlack(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function participantLabel(participant: Participant) {
  return participant.slackUserId
    ? `<@${participant.slackUserId}>`
    : escapeSlack(participant.name);
}

export function resolveRecipient({workspaceId, target}: {workspaceId: string; target: string}) {
  const mention = /^<@([UW][A-Z0-9]+)(?:\|[^>]+)?>$/.exec(target);
  return mention
    ? getParticipant({workspaceId, userId: mention[1]})
    : getParticipantByAlias({workspaceId, alias: target});
}

export function parseTipCommand(text: string) {
  const match = /^(<@[UW][A-Z0-9]+(?:\|[^>]+)?>|[a-zA-Z][a-zA-Z0-9_-]*)\s+(\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (!match) throw new Error(usage);
  const [, target, amount, message] = match;
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount) || parseUnits(amount, 6) <= 0n) {
    throw new Error('Enter an amount greater than zero with at most six decimal places.');
  }
  if (message.trim().length > 500) throw new Error('Keep the appreciation message within 500 characters.');
  return {target, amount, message: message.trim()};
}

export function validateParticipants(sender: Participant | undefined, recipient: Participant | undefined) {
  if (!sender) throw new Error('Run /tip login to link your wallet first.');
  if (!recipient) throw new Error('That coworker needs to run /tip login first. You can also tip demo.');
  if (sender.walletId === recipient.walletId || sender.address.toLowerCase() === recipient.address.toLowerCase()) {
    throw new Error('Choose someone else to tip.');
  }
  return {sender, recipient};
}

async function readBothBalances(sender: Participant, recipient: Participant) {
  const [senderBalance, recipientBalance] = await Promise.all([
    getOusdBalance(sender.address),
    getOusdBalance(recipient.address),
  ]);
  return {sender: senderBalance, recipient: recipientBalance};
}

export function formatTipSuccess({sender, recipient, amount, message, before, after, explorerUrl}: {
  sender: Participant; recipient: Participant; amount: string; message: string;
  before: Balances; after?: Balances; explorerUrl: string;
}) {
  return [
    `*${participantLabel(sender)} sent ${participantLabel(recipient)} ${formatUnits(parseUnits(amount, 6), 6)} OUSD*`,
    `“${escapeSlack(message)}”`,
    '',
    ...(after ? [
      `${participantLabel(sender)}: ${before.sender.formattedBalance} → ${after.sender.formattedBalance} OUSD`,
      `${participantLabel(recipient)}: ${before.recipient.formattedBalance} → ${after.recipient.formattedBalance} OUSD`,
    ] : ['Transfer confirmed. Balance refresh is unavailable; use /tip balance to check.']),
    'Tempo testnet · Gas sponsored',
    `<${explorerUrl}|View transaction ↗>`,
  ].join('\n');
}

async function replyPrivately(respond: RespondFn, text: string) {
  await respond({response_type: 'ephemeral', text});
}

async function handleBalance({command, respond}: CommandContext) {
  const match = /^balance(?:\s+(<@[UW][A-Z0-9]+(?:\|[^>]+)?>|[a-zA-Z][a-zA-Z0-9_-]*))?$/.exec(command.text.trim());
  if (!match) {
    await replyPrivately(respond, 'Usage: /tip balance, /tip balance demo, or /tip balance @coworker');
    return;
  }
  const participant = match[1]
    ? resolveRecipient({workspaceId: command.team_id, target: match[1]})
    : getParticipant({workspaceId: command.team_id, userId: command.user_id});
  if (!participant) {
    await replyPrivately(respond, 'No wallet is linked yet. Run /tip login, or ask that coworker to log in.');
    return;
  }
  let balance;
  try {
    balance = await getOusdBalance(participant.address);
  } catch {
    console.error('Failed to read OUSD balance.');
    await replyPrivately(respond, 'Couldn’t read the balance. Please try again.');
    return;
  }
  await replyPrivately(respond, [
    `*${participantLabel(participant)}’s balance: ${balance.formattedBalance} OUSD*`,
    'Network: Tempo testnet',
    `Wallet: \`${participant.address}\``,
  ].join('\n'));
}

async function handleTip({command, respond}: CommandContext) {
  let parsed;
  let participants;
  try {
    parsed = parseTipCommand(command.text);
    participants = validateParticipants(
      getParticipant({workspaceId: command.team_id, userId: command.user_id}),
      resolveRecipient({workspaceId: command.team_id, target: parsed.target}),
    );
  } catch (error) {
    await replyPrivately(respond, error instanceof Error ? error.message : usage);
    return;
  }
  const {sender, recipient} = participants;
  if (busyWallets.has(sender.walletId)) {
    await replyPrivately(respond, 'This wallet has a tip in progress or awaiting verification. Check that transaction before sending again.');
    return;
  }
  busyWallets.add(sender.walletId);
  const involvedWallets = [sender.walletId, recipient.walletId];
  for (const walletId of involvedWallets) activeTipWallets.set(walletId, (activeTipWallets.get(walletId) ?? 0) + 1);
  // Keep the lock if submission or confirmation is uncertain, preventing accidental repeat tips.
  let releaseLock = true;
  try {
    let before;
    try {
      before = await readBothBalances(sender, recipient);
    } catch {
      await replyPrivately(respond, 'Couldn’t read the starting balances. No tip was submitted. Please try again.');
      return;
    }
    if (before.sender.rawBalance < parseUnits(parsed.amount, 6)) {
      await replyPrivately(respond, `Insufficient balance. You have ${before.sender.formattedBalance} OUSD.`);
      return;
    }
    let submitted;
    releaseLock = false;
    try {
      submitted = await sendOusd({senderWalletId: sender.walletId, recipientAddress: recipient.address, amount: parsed.amount});
    } catch {
      console.error('Tip submission did not return a transaction hash; verify the wallet transaction history.');
      await replyPrivately(respond, 'Couldn’t verify whether the tip was submitted. Check the sender’s wallet history before retrying. After checking, restart the bot to unlock this wallet.');
      return;
    }
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({hash: submitted.hash, timeout: 30_000});
    } catch {
      await replyPrivately(respond, `Tip submitted; confirmation is still unverified. <${submitted.explorerUrl}|View transaction>. Check its status before retrying, then restart the bot to unlock this wallet.`);
      return;
    }
    releaseLock = true;
    if (receipt.status !== 'success') {
      await replyPrivately(respond, `The transaction reverted. <${submitted.explorerUrl}|View transaction>`);
      return;
    }
    let after;
    try {
      after = await readBothBalances(sender, recipient);
    } catch {
      console.error('Tip confirmed, but balance refresh failed.');
    }
    try {
      await respond({response_type: 'in_channel', text: formatTipSuccess({
        sender, recipient, ...parsed, before, after, explorerUrl: submitted.explorerUrl,
      })});
    } catch {
      console.error(`Tip confirmed, but Slack notification failed. Transaction: ${submitted.hash}`);
      await replyPrivately(respond, `Tip confirmed, but the channel message failed. <${submitted.explorerUrl}|View transaction>. Do not resend the tip.`);
    }
  } finally {
    if (releaseLock) {
      busyWallets.delete(sender.walletId);
      for (const walletId of involvedWallets) {
        const remaining = (activeTipWallets.get(walletId) ?? 1) - 1;
        if (remaining > 0) activeTipWallets.set(walletId, remaining);
        else activeTipWallets.delete(walletId);
      }
    }
  }
}

async function main() {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error('Missing SLACK_SIGNING_SECRET.');
  }
  const publicUrl = new URL(process.env.PUBLIC_APP_URL ?? '');
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_APP_URL must be an HTTPS origin.');
  }
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: createUiReceiver({signingSecret, onboarding: {
      store: participantStore, publicOrigin: publicUrl.origin, signerId: walletOwnerId,
      verifyWallet: ({accessToken, address}) => verifyOnboardingWallet({privy, accessToken, address, signerId: walletOwnerId}),
    }}),
  });
  app.command('/tip', async ({ack, command, respond}) => {
    await ack();
    console.log({workspaceId: command.team_id, userId: command.user_id});
    try {
      if (/^reset(?:\s|$)/.test(command.text.trim())) {
        await handleReset({command, respond, store: participantStore,
          deleteUser: userId => deleteResetUser({privy, userId}),
          isWalletBusy: walletId => activeTipWallets.has(walletId),
        });
      } else if (command.text.trim() === 'login') {
        await handleLogin({command, respond, publicOrigin: publicUrl.origin, store: participantStore});
      } else if (/^balance(?:\s|$)/.test(command.text.trim())) {
        await handleBalance({command, respond});
      } else {
        await handleTip({command, respond});
      }
    } catch (error) {
      if (error instanceof OnboardingError) {
        await replyPrivately(respond, error.message);
        return;
      }
      // Don’t turn notification errors into misleading transaction-failure messages.
      console.error('Tip command could not finish responding to Slack. Check transaction status before retrying.');
    }
  });
  await app.start({port: 3105, host: '0.0.0.0'});
  console.log('Tip bot listening on port 3105');
}

// Allow importing the pure helpers for offline checks without starting the server.
if (process.argv[1] && ['app.ts', 'app.js'].includes(basename(process.argv[1]))) {
  main().catch(() => {
    console.error('Failed to start the tip bot. Check its configuration and port availability.');
    process.exitCode = 1;
  });
}
