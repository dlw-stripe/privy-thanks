import {createRoot} from 'react-dom/client';
import './styles.css';

function LoginPage() {
  return (
    <main>
      <p className="eyebrow">Tempo testnet</p>
      <h1>Slack /tip</h1>
      <p>Connect your Slack account to a Privy wallet.</p>
      <p className="status">Google login is coming next.</p>
    </main>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing React root element.');
}

createRoot(root).render(<LoginPage />);
