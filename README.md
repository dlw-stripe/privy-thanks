# Slack /tip

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
- `PRIVY_WALLET_OWNER_ID`: existing registered authorization key's **key quorum ID**, now used as the bot's additional signer. This is a public identifier; the private key stays in the backend.
- `PUBLIC_APP_URL`: the HTTPS origin shared by Slack and the login UI, without a path (for example, `https://<tunnel-host>`).
- `PARTICIPANTS_DB_PATH`: optional SQLite file path; defaults to `data/privy-thanks.sqlite`.

Set `VITE_PRIVY_APP_ID` in `ui/.env.local` to the same public app ID as `PRIVY_APP_ID`. Never put an app secret, Slack token, or authorization private key in a `VITE_` variable: those values are included in the browser build.

In the Privy dashboard for that app:

- Enable Google under Login methods. Privy's default Google credentials are sufficient for development.
- Add `https://<tunnel-host>` as an allowed origin.
- Add `https://<tunnel-host>/login` as an allowed OAuth redirect URL.

The optional `participants.yaml` is imported into SQLite once on first startup, preserving the existing `demo` alias and legacy wallets. After import, changing YAML does not change wallet routing. New users run `/tip login`; completing onboarding replaces their legacy Slack mapping with their Google-owned wallet. Existing linked accounts cannot be silently switched to another Google user or wallet.

Enable Tempo testnet gas sponsorship in the Privy app. Fund the new Google-owned wallet with testnet OUSD after onboarding; the old wallet's funds do not move automatically.

`.env`, `participants.yaml`, local backups, and databases are ignored. Only sanitized configuration examples belong in Git.

## Run

Run from the project directory so the participant configuration can be found:

```bash
pnpm run build:ui
pnpm start
```

Run `/tip login` in Slack and open its private link in a regular browser. Privy’s built-in login modal opens automatically once the SDK is ready. If the modal is closed, choose **Open login** to reopen it. Privy's login modal creates a user-owned embedded Ethereum wallet for a user without a wallet. The page displays the Google account and embedded wallet address, with logout and a manual wallet-creation retry if setup did not finish. Returning users reuse their existing wallet. Once the wallet is ready, setup automatically adds the bot signer and then verifies its presence on the backend before saving the Slack link. No separate permission button is needed. A failed attempt offers **Retry wallet setup**. Already-authorized wallets skip the signer grant.

Opening `/login` directly still supports Google login and wallet display. To link or verify Slack routing, use the private link from `/tip login`.

Rebuild the UI after frontend or `ui/.env.local` edits, and restart the bot after backend edits. Google login must run in a regular browser rather than an embedded Slack webview.

All UI source, configuration, and HTTP routing live under `ui/`. Vite writes its generated output to `ui/dist/`, which is ignored by Git. The frontend loads environment files only from `ui/`, keeping the backend's root `.env` separate.

The HTTP server listens on port 3105. Configure the Slack slash command as `/tip`, enable escaping of mentions, disable Socket Mode, and set its request URL to `https://<tunnel-host>/slack/events`.

On a Stripe devbox, the app uses `undici` to honor the outbound proxy environment. Run `pay tunnel` from the laptop, targeting the registered devbox service. Allow only the Slack callback, login page, and compiled asset paths:

```bash
pay tunnel create --devbox-name=<devbox-name> --service=<registered-service> \
  --allow-paths-matching='^/(slack/events|login|assets/[^/]+|api/slack-link)$' --replace
```

Browser routes use the same tunnel hostname as the Slack callback. The server serves only built UI files; backend source and local configuration have no browser routes.

## Try the demo

```text
/tip login
/tip reset
/tip balance
/tip balance demo
/tip demo 1 Thanks for helping me onboard!
/tip balance @coworker
/tip @coworker 1 Thanks for the help!
```

Balance responses are private. Successful tips post the appreciation message, before-and-after balances, and a Tempo testnet explorer link in the channel. The `demo` alias uses a plain label and does not notify a real Slack user.

## Reset for a new demo run

Run `/tip reset` to delete the calling Slack user's linked Privy user and clear that account's local wallet mapping and login links. It cannot target a coworker or the `demo` alias. On-chain balances and transaction history remain at the old address.

After reset, log out of the browser login page, run `/tip login`, and log in with Google again. The new wallet needs its own testnet OUSD. Browser cookies are not cleared by a Slack command.

Reset is blocked while the wallet is involved in a tip, including uncertain transfers awaiting verification. Deletion is performed before removing the saved mapping. A durable reset record blocks tipping and new links while deletion is pending. If Privy is unavailable or deletion times out, run `/tip reset` again; it retries the saved user ID, including after a bot restart. A user already deleted in the dashboard is treated as a completed deletion.

## Files

- `app.ts`: Slack routing, balance and tip handlers, validation, and response formatting.
- `participants.ts`: one-time import of legacy YAML and workspace-scoped SQLite lookups.
- `onboarding/store.ts`: durable participant routing, expiring links, and atomic link completion.
- `onboarding/verify-wallet.ts`: Privy access-token, Google identity, wallet ownership, and signer verification.
- `onboarding/slack-reset.ts`: self-service reset command and active-tip guard.
- `onboarding/delete-user.ts`: Privy deletion adapter with explicit retry handling.
- `onboarding/routes.ts`: same-origin `/api/slack-link` prepare/complete handler.
- `privy.ts`: Privy client and backend authorization context.
- `wallets/balance.ts`: read OUSD balances with viem.
- `wallets/transfer.ts`: submit sponsored Tempo transfers through Privy.
- `ui/src/main.tsx`: mount the Privy provider with the public app ID.
- `ui/src/login-page.tsx`: Google login, wallet display, setup progress, retry, and logout.
- `ui/src/use-slack-link.ts`: automatic signer grant and Slack link completion after login.
- `ui/src/privy-config.ts`: Google-only login and automatic embedded wallet creation.
- `ui/src/styles.css`: page styling.
- `ui/vite.config.mts` and `ui/tsconfig.json`: frontend build and type checking.
- `ui/server.ts`: login page and asset routes on the Bolt HTTP receiver.
- `ui/server.test.ts`: HTTP coverage for UI routes and Slack signature verification.

## Checks

```bash
pnpm run check:backend
pnpm run check:ui
pnpm run test:ui
pnpm test
```

The HTTP test uses an isolated local server and generated test credentials. UI tests mock the Privy SDK to cover loading, cancellation, wallet selection, and retry behavior. Onboarding tests exercise real HTTP routes, the installed SDK's JWT verification, and SQLite; only the external Privy API responses are mocked. They cover expiry, token reuse, account conflicts, wrong-app JWTs, missing signers, legacy migration, and persistence. These tests do not perform a real Google login or grant signer access to a live wallet.

To verify the real flow:

1. Run `/tip login`, then open the private link in a regular browser.
2. Log in with Google. Wait for the wallet address to appear and the **Log out** button to become available.
3. Run `/tip balance` and confirm it displays the Google-owned wallet address.
4. Fund that wallet with testnet OUSD, then try `/tip demo 1 Thanks!`.
5. Run `/tip login` again to confirm returning users reuse their wallet and signer.

New wallets start without testnet funds. The agent does not automate personal Google credentials.

## Current limitations and next steps

The user owns the wallet and the backend holds only the bot's authorization key. Adding the bot as an additional signer allows backend transactions while the user is offline. This demo uses `policyIds: []`, granting broad signing authority: the app only exposes OUSD tips on Tempo testnet, but that restriction is not a Privy policy. Use a wallet with testnet funds only. Logging out does not revoke the signer; removing its additional signer in Privy prevents further bot signing.

The Slack link is a bearer capability: keep it private. It expires after 15 minutes and can bind only one verified Privy user and wallet. It comes from a signed Slack command, not a browser-supplied Slack ID or email match. Tokens are stored as hashes in SQLite and kept in sessionStorage across OAuth; the fragment is removed before login. Lost completion responses can be retried only for the same bound user and wallet. The API independently checks the access token, embedded-wallet ownership, and exact signer ID, and rejects cross-origin calls.

SQLite contains private Slack routing and email data. Its directory and database are restricted and ignored by Git. It persists on this devbox; this demo has no multi-host database, self-service relinking, or browser-based unlink flow. Protect the app secret and authorization key. A future production rollout needs a scoped signer policy and deliberate revocation and recovery UX.

Transfer locks live in memory. If submission or confirmation is uncertain, check the transaction history before retrying; restart the bot only after checking. There is no durable idempotency or recovery across restarts. Before-and-after balances may also include other concurrent wallet activity.
