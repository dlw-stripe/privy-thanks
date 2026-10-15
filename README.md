# Privy thanks

A Slack appreciation tipping demo powered by Privy wallets. The `/tip` command sends OUSD on Tempo testnet with sponsored gas and displays balances before and after confirmation.

## Setup

Use Node.js 24 and the pnpm version pinned in `package.json`.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
cp participants.example.yaml participants.yaml
cp ui/.env.example ui/.env.local
```

Fill in `.env` locally:

- `SLACK_BOT_TOKEN`: bot token for the installed Slack sandbox app.
- `SLACK_SIGNING_SECRET`: signing secret from the same Slack app.
- `PRIVY_APP_ID` and `PRIVY_APP_SECRET`: credentials for the demo Privy app.
- `PRIVY_AUTHORIZATION_PRIVATE_KEY`: backend key authorized to transact from the demo wallets.
- `PRIVY_WALLET_OWNER_ID`: wallet owner identifier used by the existing demo configuration; this is not the private key.

Set `VITE_PRIVY_APP_ID` in `ui/.env.local` to the same public app ID as `PRIVY_APP_ID`. Never put an app secret, Slack token, or authorization private key in a `VITE_` variable: those values are included in the browser build.

In the Privy dashboard for that app:

- Enable Google under Login methods. Privy's default Google credentials are sufficient for development.
- Add `https://<tunnel-host>` as an allowed origin.
- Add `https://<tunnel-host>/login` as an allowed OAuth redirect URL.

Replace the placeholders in `participants.yaml` with the Slack workspace ID, sender Slack user ID, and both Privy wallet IDs and addresses. Keep the `demo` alias to test without mentioning a coworker. Fund the sender with testnet OUSD and enable Tempo testnet gas sponsorship in the Privy app.

`.env`, `participants.yaml`, local backups, and databases are ignored. Only sanitized configuration examples belong in Git.

## Run

Run from the project directory so the participant configuration can be found:

```bash
pnpm run build:ui
pnpm start
```

Open `https://<tunnel-host>/login`. Privy’s built-in login modal opens automatically once the SDK is ready. If the modal is closed, choose **Open login** to reopen it. Privy's login modal creates a user-owned embedded Ethereum wallet for a user without a wallet. The page displays the Google account and embedded wallet address, with logout and a manual wallet-creation retry if setup did not finish. Returning users reuse their existing wallet.

Rebuild the UI after frontend or `ui/.env.local` edits, and restart the bot after backend edits. Google login must run in a regular browser rather than an embedded Slack webview.

All UI source, configuration, and HTTP routing live under `ui/`. Vite writes its generated output to `ui/dist/`, which is ignored by Git. The frontend loads environment files only from `ui/`, keeping the backend's root `.env` separate.

The HTTP server listens on port 3105. Configure the Slack slash command as `/tip`, enable escaping of mentions, disable Socket Mode, and set its request URL to `https://<tunnel-host>/slack/events`.

On a Stripe devbox, the app uses `undici` to honor the outbound proxy environment. Run `pay tunnel` from the laptop, targeting the registered devbox service. Allow only the Slack callback, login page, and compiled asset paths:

```bash
pay tunnel create --devbox-name=<devbox-name> --service=<registered-service> \
  --allow-paths-matching='^/(slack/events|login|assets/[^/]+)$' --replace
```

Browser routes use the same tunnel hostname as the Slack callback. The server serves only built UI files; backend source and local configuration have no browser routes.

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
- `ui/src/main.tsx`: mount the Privy provider with the public app ID.
- `ui/src/login-page.tsx`: Google login, user-owned wallet display, retry, and logout.
- `ui/src/privy-config.ts`: Google-only login and automatic embedded wallet creation.
- `ui/src/styles.css`: page styling.
- `ui/vite.config.mts` and `ui/tsconfig.json`: frontend build and type checking.
- `ui/server.ts`: login page and asset routes on the Bolt HTTP receiver.
- `ui/server.test.ts`: HTTP coverage for UI routes and Slack signature verification.

## Checks

```bash
pnpm run check:ui
pnpm run test:ui
pnpm test
```

The HTTP test uses an isolated local server and generated test credentials. UI tests mock the Privy SDK to cover loading, cancellation, wallet selection, and retry behavior. These automated tests do not perform a real Google login or create on-chain wallets.

To verify the real flow, log in with Google, note the wallet address, log out, and log back in. Confirm the address stays the same. New wallets start without testnet funds.

## Current limitations and next steps

The browser supports Google login and user-owned wallets. Slack commands still use the existing backend-controlled demo wallets and local YAML mapping. Connecting the new wallets to Slack, authorizing the bot signer, and persisting Slack-to-Privy associations are the next steps. Logging in does not grant the bot spending permission or change the current Slack wallet mapping.

Transfer locks live in memory. If submission or confirmation is uncertain, check the transaction history before retrying; restart the bot only after checking. There is no durable idempotency or recovery across restarts. Before-and-after balances may also include other concurrent wallet activity.
