import {usePrivy, useSigners} from '@privy-io/react-auth';
import {useEffect, useRef, useState} from 'react';

const LINK_STORAGE_KEY = 'slack-tip.pending-link';
type LinkState =
  | {phase: 'idle' | 'checking' | 'authorizing' | 'saving'}
  | {phase: 'linked'; slackUserId: string}
  | {phase: 'error'; message: string};
type LinkResponse = {signerId: string; hasBotSigner: boolean; slackUserId: string; linked: boolean};

/** Automatically authorize and link a wallet when opened from /tip login. */
export function useSlackLink({enabled, address}: {enabled: boolean; address?: string}) {
  const {user, getAccessToken} = usePrivy();
  const {addSigners} = useSigners();
  const [linkToken, setLinkToken] = useState(readPendingLink);
  const [result, setResult] = useState<{key: string | null; state: LinkState}>({key: null, state: {phase: 'idle'}});
  const [retryCount, setRetryCount] = useState(0);
  const attempt = useRef<{key: string; promise: Promise<string>} | null>(null);
  const key = enabled && user && address && linkToken ? `${user.id}:${address}:${linkToken}:${retryCount}` : null;
  const currentKey = useRef(key);
  currentKey.current = key;

  useEffect(() => {
    function captureSlackLink() {
      // A queued hashchange may arrive after the fragment and storage were cleared.
      if (new URLSearchParams(window.location.hash.slice(1)).has('link')) {
        setLinkToken(readPendingLink());
      }
    }
    window.addEventListener('hashchange', captureSlackLink);
    return () => window.removeEventListener('hashchange', captureSlackLink);
  }, []);

  useEffect(() => {
    if (!key || !address || !linkToken) return;
    currentKey.current = key;
    // Reuse the same attempt through StrictMode and unstable SDK function references.
    let observing = true;
    function update(next: LinkState) {
      if (currentKey.current === key) setResult({key, state: next});
    }
    function assertCurrentAccount() {
      if (currentKey.current !== key) throw new Error('The account changed. Run /tip login again.');
    }
    async function linkWallet() {
      update({phase: 'checking'});
      const accessToken = await getAccessToken().catch(() => {
        throw new Error('Log in again to continue wallet setup.');
      });
      assertCurrentAccount();
      if (!accessToken) throw new Error('Log in again to continue wallet setup.');
      const prepared = await requestSlackLink({action: 'prepare', accessToken, linkToken: linkToken!, walletAddress: address!});
      assertCurrentAccount();
      if (!prepared.hasBotSigner) {
        update({phase: 'authorizing'});
        try {
          await addSigners({address: address!, signers: [{signerId: prepared.signerId, policyIds: []}]});
        } catch {
          throw new Error('Bot permission wasn’t added. Retry wallet setup to continue.');
        }
      }
      assertCurrentAccount();
      update({phase: 'saving'});
      const completed = await requestSlackLink({action: 'complete', accessToken, linkToken: linkToken!, walletAddress: address!});
      if (!completed.linked) throw new Error('Couldn’t confirm the Slack link. Retry wallet setup.');
      return completed.slackUserId;
    }
    if (attempt.current?.key !== key) attempt.current = {key, promise: linkWallet()};
    attempt.current.promise.then(slackUserId => {
      if (!observing || currentKey.current !== key) return;
      if (sessionStorage.getItem(LINK_STORAGE_KEY) === linkToken) sessionStorage.removeItem(LINK_STORAGE_KEY);
      setResult(previous => previous.key === key && previous.state.phase === 'linked'
        ? previous : {key, state: {phase: 'linked', slackUserId}});
    }, error => {
      if (!observing || currentKey.current !== key) return;
      setResult(previous => previous.key === key && previous.state.phase === 'error'
        ? previous : {key, state: {phase: 'error', message: error instanceof Error ? error.message : 'Couldn’t link the wallet. Retry wallet setup.'}});
    });
    return () => {
      observing = false;
      if (currentKey.current === key) currentKey.current = null;
    };
  }, [key, address, linkToken, getAccessToken, addSigners]);

  const visibleState: LinkState = key && result.key === key ? result.state : {phase: 'idle'};
  return {
    state: visibleState, hasLink: Boolean(linkToken),
    busy: Boolean(key) && ['idle', 'checking', 'authorizing', 'saving'].includes(visibleState.phase),
    retry: () => setRetryCount(value => value + 1),
  };
}

function readPendingLink(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get('link');
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    // OAuth redirects may reload the page; keep the capability in this tab only.
    sessionStorage.setItem(LINK_STORAGE_KEY, token);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return token;
  }
  return sessionStorage.getItem(LINK_STORAGE_KEY);
}

async function requestSlackLink({action, accessToken, linkToken, walletAddress}: {
  action: 'prepare' | 'complete'; accessToken: string; linkToken: string; walletAddress: string;
}): Promise<LinkResponse> {
  let response;
  try {
    response = await fetch('/api/slack-link', {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`},
      body: JSON.stringify({action, linkToken, walletAddress}), signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Couldn’t reach the bot. Check the connection and retry wallet setup.');
  }
  let body;
  try { body = await response.json(); } catch {
    throw new Error('Couldn’t read the setup response. Retry wallet setup.');
  }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Couldn’t link the wallet. Retry wallet setup.');
  if (typeof body.signerId !== 'string' || typeof body.hasBotSigner !== 'boolean' ||
      typeof body.slackUserId !== 'string' || typeof body.linked !== 'boolean') {
    throw new Error('Couldn’t read the setup response. Retry wallet setup.');
  }
  return body;
}
