import {readFileSync} from 'node:fs';
import {parse} from 'yaml';

export type Participant = {
  alias?: string;
  name: string;
  slackUserId: string | null;
  email: string | null;
  walletId: string;
  address: `0x${string}`;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Launch the bot from ~/privy-thanks so this resolves beside app.ts.
const config: unknown = parse(readFileSync('participants.yaml', 'utf8'));
if (
  !isRecord(config) ||
  typeof config.workspaceId !== 'string' ||
  !/^T[A-Z0-9]+$/.test(config.workspaceId) ||
  !Array.isArray(config.participants)
) {
  throw new Error('participants.yaml needs a valid workspaceId and participants list.');
}

const participantsBySlackIdentity = new Map<string, Participant>();
const participantsByAlias = new Map<string, Participant>();
for (const [index, entry] of config.participants.entries()) {
  if (
    !isRecord(entry) ||
    typeof entry.name !== 'string' || !entry.name.trim() ||
    !(entry.alias === undefined || (typeof entry.alias === 'string' && /^[a-z][a-z0-9_-]*$/.test(entry.alias))) ||
    typeof entry.walletId !== 'string' || !entry.walletId.trim() ||
    typeof entry.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry.address) ||
    !(entry.slackUserId === null ||
      (typeof entry.slackUserId === 'string' && /^[UW][A-Z0-9]+$/.test(entry.slackUserId))) ||
    !(entry.email === null || (typeof entry.email === 'string' && entry.email.trim()))
  ) {
    throw new Error(`Invalid participant at index ${index} in participants.yaml.`);
  }

  const participant: Participant = {
    name: entry.name,
    alias: entry.alias as string | undefined,
    slackUserId: entry.slackUserId,
    email: entry.email,
    walletId: entry.walletId,
    address: entry.address as `0x${string}`,
  };
  if (participant.alias) {
    const aliasKey = `${config.workspaceId}:${participant.alias}`;
    if (participantsByAlias.has(aliasKey)) {
      throw new Error(`Duplicate alias in participants.yaml: ${participant.alias}`);
    }
    participantsByAlias.set(aliasKey, participant);
  }
  // An unfilled coworker entry must never match an incoming Slack command.
  if (participant.slackUserId === null) continue;

  const key = `${config.workspaceId}:${participant.slackUserId}`;
  if (participantsBySlackIdentity.has(key)) {
    throw new Error(`Duplicate Slack identity in participants.yaml: ${key}`);
  }
  participantsBySlackIdentity.set(key, participant);
}

export function getParticipant({workspaceId, userId}: {workspaceId: string; userId: string}) {
  return participantsBySlackIdentity.get(`${workspaceId}:${userId}`);
}

export function getParticipantByAlias({workspaceId, alias}: {workspaceId: string; alias: string}) {
  return participantsByAlias.get(`${workspaceId}:${alias.toLowerCase()}`);
}
