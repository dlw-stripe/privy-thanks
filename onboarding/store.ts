import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {OnboardingError, type Participant, type ResetRequest, type SlackAccount, type SlackIdentity, type VerifiedWallet} from './types';

const LINK_LIFETIME_MILLISECONDS = 15 * 60 * 1000;
type LinkRow = {
  workspace_id: string; user_id: string; name: string; expires_at: number;
  privy_user_id: string | null; wallet_id: string | null; consumed_at: number | null;
};

/** Durable wallet routing and single-use Slack login links. */
export class OnboardingStore {
  private db: DatabaseSync;

  constructor(path: string, private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS participants (
        workspace_id TEXT NOT NULL, slot TEXT NOT NULL, slack_user_id TEXT,
        alias TEXT, name TEXT NOT NULL, email TEXT, wallet_id TEXT NOT NULL,
        address TEXT NOT NULL COLLATE NOCASE, privy_user_id TEXT,
        PRIMARY KEY (workspace_id, slot),
        UNIQUE (workspace_id, slack_user_id), UNIQUE (workspace_id, alias),
        UNIQUE (workspace_id, wallet_id), UNIQUE (workspace_id, address),
        UNIQUE (workspace_id, privy_user_id)
      );
      CREATE TABLE IF NOT EXISTS login_links (
        token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
        name TEXT NOT NULL, expires_at INTEGER NOT NULL,
        privy_user_id TEXT, wallet_id TEXT, consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS onboarding_resets (
        workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, privy_user_id TEXT, wallet_id TEXT,
        PRIMARY KEY (workspace_id, user_id)
      );
    `);
  }

  close() { this.db.close(); }

  hasLegacyImport() {
    return Boolean(this.db.prepare('SELECT name FROM migrations WHERE name = ?').get('legacy-yaml'));
  }

  getParticipant({workspaceId, userId}: {workspaceId: string; userId: string}) {
    return this.readParticipant('slack_user_id', workspaceId, userId);
  }

  getParticipantByAlias({workspaceId, alias}: {workspaceId: string; alias: string}) {
    return this.readParticipant('alias', workspaceId, alias.toLowerCase());
  }

  getPendingReset({workspaceId, userId}: SlackAccount): ResetRequest | undefined {
    const row = this.db.prepare('SELECT * FROM onboarding_resets WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId);
    if (!row) return undefined;
    return {operationId: String(row.operation_id), privyUserId: row.privy_user_id as string | null,
      walletId: row.wallet_id as string | null};
  }

  /** Invalidate old links and freeze routing before calling Privy's delete API. */
  beginReset(identity: SlackAccount): ResetRequest {
    return this.transaction(() => {
      const pending = this.getPendingReset(identity);
      if (pending) return pending;
      const participant = this.getParticipant(identity);
      const target: ResetRequest = {operationId: randomUUID(), privyUserId: participant?.privyUserId ?? null,
        walletId: participant?.walletId ?? null};
      this.db.prepare(`INSERT INTO onboarding_resets
        (workspace_id, user_id, operation_id, privy_user_id, wallet_id) VALUES (?, ?, ?, ?, ?)`)
        .run(identity.workspaceId, identity.userId, target.operationId, target.privyUserId, target.walletId);
      this.db.prepare('DELETE FROM login_links WHERE workspace_id = ? AND user_id = ?')
        .run(identity.workspaceId, identity.userId);
      return target;
    });
  }

  /** Clear only this account after deletion succeeds; stale completions cannot clear a new login. */
  finishReset({workspaceId, userId, operationId}: SlackAccount & {operationId: string}) {
    this.transaction(() => {
      if (this.getPendingReset({workspaceId, userId})?.operationId !== operationId) return;
      this.db.prepare('DELETE FROM participants WHERE workspace_id = ? AND slack_user_id = ?')
        .run(workspaceId, userId);
      this.db.prepare('DELETE FROM login_links WHERE workspace_id = ? AND user_id = ?')
        .run(workspaceId, userId);
      this.db.prepare('DELETE FROM onboarding_resets WHERE workspace_id = ? AND user_id = ? AND operation_id = ?')
        .run(workspaceId, userId, operationId);
    });
  }

  /** Import existing demo wallets once; subsequent startups cannot overwrite links. */
  importLegacy({workspaceId, participants}: {workspaceId: string; participants: Participant[]}) {
    this.transaction(() => {
      if (this.hasLegacyImport()) return;
      for (const participant of participants) {
        if (!participant.slackUserId && !participant.alias) continue;
        this.db.prepare(`INSERT INTO participants
          (workspace_id, slot, slack_user_id, alias, name, email, wallet_id, address)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          workspaceId, participant.slackUserId ? `user:${participant.slackUserId}` : `alias:${participant.alias}`,
          participant.slackUserId, participant.alias ?? null, participant.name,
          participant.email, participant.walletId, participant.address,
        );
      }
      this.db.prepare('INSERT INTO migrations (name) VALUES (?)').run('legacy-yaml');
    });
  }

  issueLink(identity: SlackIdentity) {
    const token = randomBytes(32).toString('hex');
    this.transaction(() => {
      if (this.getPendingReset(identity)) {
        throw new OnboardingError(409, 'Reset is pending. Run /tip reset again to finish.');
      }
      this.db.prepare('DELETE FROM login_links WHERE expires_at <= ? OR (workspace_id = ? AND user_id = ?)')
        .run(this.now(), identity.workspaceId, identity.userId);
      this.db.prepare(`INSERT INTO login_links (token_hash, workspace_id, user_id, name, expires_at)
        VALUES (?, ?, ?, ?, ?)`).run(hashToken(token), identity.workspaceId, identity.userId,
        identity.name, this.now() + LINK_LIFETIME_MILLISECONDS);
    });
    return token;
  }

  /** Reject invalid links before making an external API request. */
  checkLink(token: string) { this.readLink(token); }

  /** Reserve a link for a verified wallet before granting the bot access. */
  prepareLink(token: string, wallet: VerifiedWallet) {
    return this.transaction(() => {
      const link = this.readLink(token);
      this.assertBinding(link, wallet);
      this.assertCanLink(link, wallet);
      this.db.prepare('UPDATE login_links SET privy_user_id = ?, wallet_id = ? WHERE token_hash = ?')
        .run(wallet.privyUserId, wallet.walletId, hashToken(token));
      return {slackUserId: link.user_id, workspaceId: link.workspace_id};
    });
  }

  /** Save routing and consume the link atomically; identical retries are read-only. */
  completeLink(token: string, wallet: VerifiedWallet) {
    return this.transaction(() => {
      const link = this.readLink(token);
      this.assertBinding(link, wallet);
      if (!link.privy_user_id || !link.wallet_id) {
        throw new OnboardingError(409, 'Start wallet setup again from the login page.');
      }
      this.assertCanLink(link, wallet);
      if (!wallet.hasBotSigner) throw new OnboardingError(409, 'Bot permission is missing. Retry wallet setup.');
      if (link.consumed_at === null) {
        this.db.prepare(`INSERT INTO participants
          (workspace_id, slot, slack_user_id, name, email, wallet_id, address, privy_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, slot) DO UPDATE SET
            name = excluded.name, email = excluded.email, wallet_id = excluded.wallet_id,
            address = excluded.address, privy_user_id = excluded.privy_user_id`).run(
          link.workspace_id, `user:${link.user_id}`, link.user_id, link.name,
          wallet.email, wallet.walletId, wallet.address, wallet.privyUserId,
        );
        this.db.prepare('UPDATE login_links SET consumed_at = ? WHERE token_hash = ?')
          .run(this.now(), hashToken(token));
      }
      return {slackUserId: link.user_id, workspaceId: link.workspace_id};
    });
  }

  private readParticipant(column: 'slack_user_id' | 'alias', workspaceId: string, value: string): Participant | undefined {
    const row = this.db.prepare(`SELECT * FROM participants WHERE workspace_id = ? AND ${column} = ?
      AND NOT EXISTS (SELECT 1 FROM onboarding_resets WHERE onboarding_resets.workspace_id = participants.workspace_id
        AND onboarding_resets.user_id = participants.slack_user_id)`)
      .get(workspaceId, value);
    if (!row) return undefined;
    return {
      name: String(row.name), slackUserId: row.slack_user_id as string | null,
      alias: row.alias ? String(row.alias) : undefined, email: row.email as string | null,
      walletId: String(row.wallet_id), address: String(row.address) as `0x${string}`,
      privyUserId: row.privy_user_id ? String(row.privy_user_id) : undefined,
    };
  }

  private readLink(token: string): LinkRow {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new OnboardingError(410, 'Run /tip login for a new link.');
    const row = this.db.prepare('SELECT * FROM login_links WHERE token_hash = ?').get(hashToken(token));
    if (!row || Number(row.expires_at) <= this.now()) {
      throw new OnboardingError(410, 'This link expired. Run /tip login for a new link.');
    }
    return row as unknown as LinkRow;
  }

  private assertBinding(link: LinkRow, wallet: VerifiedWallet) {
    if ((link.privy_user_id && link.privy_user_id !== wallet.privyUserId) ||
        (link.wallet_id && link.wallet_id !== wallet.walletId)) {
      throw new OnboardingError(409, 'This link was started with another account. Run /tip login again.');
    }
  }

  private assertCanLink(link: LinkRow, wallet: VerifiedWallet) {
    const existing = this.getParticipant({workspaceId: link.workspace_id, userId: link.user_id});
    if (existing?.privyUserId &&
        (existing.privyUserId !== wallet.privyUserId || existing.walletId !== wallet.walletId)) {
      throw new OnboardingError(409, 'This Slack account already has a different linked wallet.');
    }
    const claimed = this.db.prepare(`SELECT slot FROM participants WHERE workspace_id = ?
      AND (wallet_id = ? OR address = ? OR privy_user_id = ?)
      AND slot != ?`).get(link.workspace_id, wallet.walletId, wallet.address,
      wallet.privyUserId, `user:${link.user_id}`);
    if (claimed) throw new OnboardingError(409, 'This wallet is already linked in this workspace.');
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
