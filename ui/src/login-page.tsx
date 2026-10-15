import {useCreateWallet, useLogin, useModalStatus, usePrivy, useWallets} from '@privy-io/react-auth';
import {useCallback, useEffect, useRef, useState} from 'react';

/** Log in with Google and display the user's embedded Ethereum wallet. */
export function LoginPage() {
  const {ready, authenticated, user, logout} = usePrivy();
  const {ready: walletsReady, wallets} = useWallets();
  const {createWallet} = useCreateWallet();
  const {isOpen: isModalOpen} = useModalStatus();
  const hasOpenedLogin = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const {login} = useLogin({
    onComplete: () => setError(null),
    onError: (code) => {
      // Closing the login dialog is an ordinary cancellation.
      if (code !== 'exited_auth_flow') {
        setError('Couldn’t log in. Please try again.');
      }
    },
  });
  const embeddedWallet = wallets.find(
    (wallet) => wallet.walletClientType === 'privy' && wallet.connectorType === 'embedded',
  );

  const openLogin = useCallback(() => {
    setError(null);
    try {
      login({loginMethods: ['google']});
    } catch {
      setError('Couldn’t open login. Please try again.');
    }
  }, [login]);

  useEffect(() => {
    if (!ready || authenticated || hasOpenedLogin.current) return;
    // Open once per page load so closing the modal does not trap the user.
    hasOpenedLogin.current = true;
    // Privy may already have opened its modal while handling an OAuth return.
    if (!isModalOpen) openLogin();
  }, [ready, authenticated, isModalOpen, openLogin]);

  async function handleCreateWallet() {
    if (!authenticated || !walletsReady || embeddedWallet || creatingWallet || loggingOut) return;
    setError(null);
    setCreatingWallet(true);
    try {
      // Automatic creation runs in Privy's login flow. This is a manual retry only.
      await createWallet();
    } catch {
      setError('Couldn’t create the wallet. Please try again.');
    } finally {
      setCreatingWallet(false);
    }
  }

  async function handleLogout() {
    setError(null);
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      setError('Couldn’t log out. Please try again.');
    } finally {
      setLoggingOut(false);
    }
  }

  if (!ready || (authenticated && !user)) {
    return (
      <main className="login-launcher">
        <p role="status">Loading login…</p>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="login-launcher">
        {!isModalOpen && (
          <>
            <h1>Slack /tip</h1>
            <button type="button" onClick={openLogin}>Open login</button>
          </>
        )}
        {error && <p role="alert" className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main className="page-card">
      <p className="eyebrow">Tempo testnet</p>
      <h1>Slack /tip</h1>
      <p>Logged in</p>
      <dl className="identity">
        <dt>Google account</dt>
        <dd>{user?.google?.email ?? user?.email?.address ?? 'Google account'}</dd>
        <dt>Wallet</dt>
        <dd>
          {embeddedWallet ? (
            <code className="wallet-address">{embeddedWallet.address}</code>
          ) : !walletsReady || creatingWallet ? (
            <span role="status">Preparing wallet…</span>
          ) : (
            'Wallet setup hasn’t finished.'
          )}
        </dd>
      </dl>
      {!embeddedWallet && walletsReady && (
        <button type="button" onClick={handleCreateWallet} disabled={creatingWallet || loggingOut}>
          {creatingWallet ? 'Creating wallet…' : 'Create wallet'}
        </button>
      )}
      <button type="button" className="secondary" onClick={handleLogout} disabled={loggingOut || creatingWallet}>
        {loggingOut ? 'Logging out…' : 'Log out'}
      </button>
      <p className="status">This wallet is not linked to Slack yet.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </main>
  );
}
