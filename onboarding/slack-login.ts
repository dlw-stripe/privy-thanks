import type {RespondFn, SlashCommand} from '@slack/bolt';
import type {OnboardingStore} from './store';

/** Issue a private link for the identity from a signature-verified Slack command. */
export async function handleLogin({command, respond, publicOrigin, store}: {
  command: SlashCommand; respond: RespondFn; publicOrigin: string; store: OnboardingStore;
}) {
  const token = store.issueLink({workspaceId: command.team_id, userId: command.user_id, name: command.user_name});
  await respond({response_type: 'ephemeral', text: [
    'Links expire in 15 minutes. Keep this link private.',
    `<${publicOrigin}/login#link=${token}|Log in and set up /tip>`,
  ].join('\n')});
}
