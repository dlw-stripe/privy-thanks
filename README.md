# Privy thanks

A Slack appreciation tipping demo powered by Privy wallets. The `/tip` command sends OUSD on Tempo testnet with sponsored gas and displays balances before and after confirmation.

## Setup

Use Node.js 24 and the pnpm version pinned in `package.json`.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
cp participants.example.yaml participants.yaml
```

Fill in `.env` locally:

- `SLACK_BOT_TOKEN`: bot token for the installed Slack sandbox app.
- `SLACK_SIGNING_SECRET`: signing secret from the same Slack app.
- `PRIVY_APP_ID` and `PRIVY_APP_SECRET`: credentials for the demo Privy app.
- `PRIVY_AUTHORIZATION_PRIVATE_KEY`: backend key authorized to transact from the demo wallets.
- `PRIVY_WALLET_OWNER_ID`: wallet owner identifier used by the existing demo configuration; this is not the private key.

Replace the placeholders in `participants.yaml` with the Slack workspace ID, sender Slack user ID, and both Privy wallet IDs and addresses. Keep the `demo` alias to test without mentioning a coworker. Fund the sender with testnet OUSD and enable Tempo testnet gas sponsorship in the Privy app.

`.env`, `participants.yaml`, local backups, and databases are ignored. Only sanitized configuration examples belong in Git.

## Run

Run from the project directory so the participant configuration can be found:

```bash
pnpm exec tsx --env-file=.env app.ts
```

The HTTP server listens on port 3105. Configure the Slack slash command as `/tip`, enable escaping of mentions, disable Socket Mode, and set its request URL to `https://<tunnel-host>/slack/events`.

On a Stripe devbox, the app uses `undici` to honor the outbound proxy environment. Run `pay tunnel` from the laptop, targeting the registered devbox service. Keep the webhook path exception scoped to `^/slack/events$`.

## Try the demo

```text
/tip balance
/tip balance demo
/tip demo 1 Thanks for helping me onboard!
/tip balance @coworker
/tip @coworker 1 Thanks for the help!
```

Balance responses are private. Successful tips post the appreciation message, before-and-after balances, and a Tempo testnet explorer link in the channel. The `demo` alias uses a plain label and does not notify a real Slack user.

## Files

- `app.ts`: Slack routing, balance and tip handlers, validation, and response formatting.
- `participants.ts`: workspace-scoped participant and alias lookup.
- `privy.ts`: Privy client and backend authorization context.
- `wallets/balance.ts`: read OUSD balances with viem.
- `wallets/transfer.ts`: submit sponsored Tempo transfers through Privy.

## Current limitations and next steps

This version uses backend-controlled demo wallets and a local YAML mapping. Google login, user-owned wallets, signer consent, and persistent Slack-to-Privy linking are planned and are not implemented yet.

Transfer locks live in memory. If submission or confirmation is uncertain, check the transaction history before retrying; restart the bot only after checking. There is no durable idempotency or recovery across restarts. Before-and-after balances may also include other concurrent wallet activity.
