import {PrivyProvider} from '@privy-io/react-auth';
import {createRoot} from 'react-dom/client';
import {LoginPage} from './login-page';
import {privyConfig} from './privy-config';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing React root element.');
}

const appId = import.meta.env.VITE_PRIVY_APP_ID?.trim();
const reactRoot = createRoot(root);

if (!appId) {
  reactRoot.render(
    <main className="page-card">
      <h1>Slack /tip</h1>
      <p role="alert">Login is unavailable. Please contact the app owner.</p>
    </main>,
  );
} else {
  reactRoot.render(
    <PrivyProvider appId={appId} config={privyConfig}>
      <LoginPage />
    </PrivyProvider>,
  );
}
