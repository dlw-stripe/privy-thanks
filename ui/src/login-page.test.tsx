import {StrictMode} from 'react';
import {randomBytes, randomUUID} from 'node:crypto';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LoginPage} from './login-page';

type TestUser = {id: string; google: {email: string}};
type TestWallet = {address: string; walletClientType: string; connectorType: string};
const sdk = vi.hoisted(() => ({
  ready: true,
  authenticated: false,
  user: null as TestUser | null,
  walletsReady: true,
  modalOpen: false,
  wallets: [] as TestWallet[],
  login: vi.fn(),
  logout: vi.fn(),
  createWallet: vi.fn(),
  getAccessToken: vi.fn(),
  addSigners: vi.fn(),
  callbacks: {} as {onError?: (code: string) => void; onComplete?: () => void},
}));

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({ready: sdk.ready, authenticated: sdk.authenticated, user: sdk.user, logout: sdk.logout, getAccessToken: sdk.getAccessToken}),
  useSigners: () => ({addSigners: sdk.addSigners}),
  useWallets: () => ({ready: sdk.walletsReady, wallets: sdk.wallets}),
  useCreateWallet: () => ({createWallet: sdk.createWallet}),
  useModalStatus: () => ({isOpen: sdk.modalOpen}),
  useLogin: (callbacks: typeof sdk.callbacks) => {
    sdk.callbacks = callbacks;
    return {login: sdk.login};
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/login');
  sdk.getAccessToken.mockResolvedValue(randomUUID());
  sdk.ready = true;
  sdk.authenticated = false;
  sdk.user = null;
  sdk.walletsReady = true;
  sdk.modalOpen = false;
  sdk.wallets = [];
  sdk.callbacks = {};
});
afterEach(cleanup);

function authenticate() {
  sdk.authenticated = true;
  sdk.user = {id: randomUUID(), google: {email: `${randomUUID()}@example.test`}};
  return sdk.user;
}

function makeWallet(walletClientType: string, connectorType: string): TestWallet {
  return {address: `0x${randomBytes(20).toString('hex')}`, walletClientType, connectorType};
}

test('opens the built-in modal once when Privy becomes ready', () => {
  sdk.ready = false;
  const {rerender} = render(<LoginPage />);
  expect(screen.getByRole('status').textContent).toBe('Loading login…');
  expect(sdk.login).not.toHaveBeenCalled();
  sdk.ready = true;
  rerender(<LoginPage />);
  expect(sdk.login).toHaveBeenCalledExactlyOnceWith({loginMethods: ['google']});
  rerender(<LoginPage />);
  expect(sdk.login).toHaveBeenCalledTimes(1);
});

test('does not open duplicate modals in React StrictMode', () => {
  render(<StrictMode><LoginPage /></StrictMode>);
  expect(sdk.login).toHaveBeenCalledTimes(1);
});

test('preserves a modal that Privy already opened during an OAuth return', () => {
  sdk.modalOpen = true;
  const {rerender} = render(<LoginPage />);
  expect(sdk.login).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', {name: 'Open login'})).toBeNull();
  sdk.modalOpen = false;
  rerender(<LoginPage />);
  expect(sdk.login).not.toHaveBeenCalled();
  expect(screen.getByRole('button', {name: 'Open login'})).toBeTruthy();
});

test('allows cancellation and manual reopening without automatically reopening', async () => {
  const {rerender} = render(<LoginPage />);
  expect(sdk.login).toHaveBeenCalledTimes(1);
  act(() => sdk.callbacks.onError?.('exited_auth_flow'));
  rerender(<LoginPage />);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(sdk.login).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Log in with Google to create a wallet for coworker appreciation.')).toBeNull();
  await userEvent.click(screen.getByRole('button', {name: 'Open login'}));
  expect(sdk.login).toHaveBeenCalledTimes(2);
  act(() => sdk.callbacks.onError?.('unknown_auth_error'));
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t log in');
});

test('shows the embedded wallet and reuses it across renders', () => {
  const user = authenticate();
  const external = makeWallet('metamask', 'injected');
  const crossApp = makeWallet('privy', 'cross_app');
  const embedded = makeWallet('privy', 'embedded');
  sdk.wallets = [external, crossApp, embedded];
  const {rerender} = render(<LoginPage />);
  expect(screen.getByText(user.google.email)).toBeTruthy();
  expect(screen.getByText(embedded.address)).toBeTruthy();
  expect(screen.queryByText(external.address)).toBeNull();
  expect(screen.queryByText(crossApp.address)).toBeNull();
  rerender(<LoginPage />);
  expect(screen.getByText(embedded.address)).toBeTruthy();
  expect(sdk.createWallet).not.toHaveBeenCalled();
  expect(sdk.login).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', {name: 'Create wallet'})).toBeNull();
  expect(screen.getByText('Run /tip login in Slack to link or check this wallet.')).toBeTruthy();
});

test('waits for wallet discovery before offering manual wallet creation', () => {
  authenticate();
  sdk.walletsReady = false;
  render(<LoginPage />);
  expect(screen.getByRole('status').textContent).toBe('Preparing wallet…');
  expect(screen.queryByRole('button', {name: 'Create wallet'})).toBeNull();
  expect(sdk.createWallet).not.toHaveBeenCalled();
});

test('allows a manual retry after wallet creation fails', async () => {
  authenticate();
  sdk.createWallet.mockRejectedValueOnce(new Error('test failure')).mockResolvedValueOnce({});
  render(<LoginPage />);
  await userEvent.click(screen.getByRole('button', {name: 'Create wallet'}));
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t create the wallet');
  await userEvent.click(screen.getByRole('button', {name: 'Create wallet'}));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(sdk.createWallet).toHaveBeenCalledTimes(2);
});

test('handles logout failures and allows another attempt', async () => {
  authenticate();
  sdk.wallets = [makeWallet('privy', 'embedded')];
  sdk.logout.mockRejectedValueOnce(new Error('test failure')).mockResolvedValueOnce(undefined);
  render(<LoginPage />);
  await userEvent.click(screen.getByRole('button', {name: 'Log out'}));
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t log out');
  await userEvent.click(screen.getByRole('button', {name: 'Log out'}));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(sdk.logout).toHaveBeenCalledTimes(2);
});

function openSlackLink() {
  const linkToken = randomBytes(32).toString('hex');
  window.history.replaceState(null, '', `/login#link=${linkToken}`);
  return linkToken;
}

function mockLinkApi({hasBotSigner = false}: {hasBotSigner?: boolean} = {}) {
  const signerId = randomUUID();
  const slackUserId = `U${randomBytes(6).toString('hex')}`;
  const requests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    return Response.json({signerId, slackUserId, hasBotSigner,
      linked: body.action === 'complete'});
  });
  vi.stubGlobal('fetch', fetchMock);
  return {fetchMock, requests, signerId, slackUserId};
}

afterEach(() => vi.unstubAllGlobals());

test('automatically adds the exact bot signer after login, then verifies and links Slack once', async () => {
  const linkToken = openSlackLink();
  authenticate();
  const embedded = makeWallet('privy', 'embedded');
  sdk.wallets = [embedded];
  const api = mockLinkApi();
  sdk.addSigners.mockResolvedValue({});
  render(<StrictMode><LoginPage /></StrictMode>);
  await waitFor(() => expect(sessionStorage.getItem('slack-tip.pending-link')).toBeNull());
  expect(screen.queryByText(/Wallet linked to Slack/)).toBeNull();
  expect(sdk.addSigners).toHaveBeenCalledExactlyOnceWith({address: embedded.address,
    signers: [{signerId: api.signerId, policyIds: []}]});
  expect(api.requests).toEqual([
    {action: 'prepare', linkToken, walletAddress: embedded.address},
    {action: 'complete', linkToken, walletAddress: embedded.address},
  ]);
  expect(window.location.hash).toBe('');
  expect(sessionStorage.getItem('slack-tip.pending-link')).toBeNull();
  expect(screen.queryByRole('button', {name: 'Retry wallet setup'})).toBeNull();
});

test('waits for the authenticated wallet and preserves the Slack link through OAuth reloads', async () => {
  const linkToken = openSlackLink();
  const api = mockLinkApi({hasBotSigner: true});
  const view = render(<LoginPage />);
  expect(api.fetchMock).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('slack-tip.pending-link')).toBe(linkToken);
  view.unmount();
  authenticate();
  sdk.walletsReady = false;
  const {rerender} = render(<LoginPage />);
  expect(api.fetchMock).not.toHaveBeenCalled();
  sdk.walletsReady = true;
  sdk.wallets = [makeWallet('privy', 'embedded')];
  rerender(<LoginPage />);
  await waitFor(() => expect(sessionStorage.getItem('slack-tip.pending-link')).toBeNull());
  expect(api.requests[0]).toHaveProperty('linkToken', linkToken);
  expect(sdk.addSigners).not.toHaveBeenCalled();
});

test('does not grant bot permission when /login was opened without a Slack link', () => {
  authenticate();
  sdk.wallets = [makeWallet('privy', 'embedded')];
  const api = mockLinkApi();
  render(<LoginPage />);
  expect(api.fetchMock).not.toHaveBeenCalled();
  expect(sdk.addSigners).not.toHaveBeenCalled();
});

test('does not grant permission for an expired link and shows the backend recovery instruction', async () => {
  openSlackLink();
  authenticate();
  sdk.wallets = [makeWallet('privy', 'embedded')];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({error: 'This link expired. Run /tip login for a new link.'}, {status: 410})));
  render(<LoginPage />);
  expect((await screen.findByRole('alert')).textContent).toContain('Run /tip login');
  expect(sdk.addSigners).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('slack-tip.pending-link')).toBeTruthy();
});

test('a rejected signer grant does not complete linking and can be retried deliberately', async () => {
  openSlackLink();
  authenticate();
  sdk.wallets = [makeWallet('privy', 'embedded')];
  const api = mockLinkApi();
  sdk.addSigners.mockRejectedValueOnce(new Error('SDK diagnostic')).mockResolvedValueOnce({});
  render(<LoginPage />);
  expect((await screen.findByRole('alert')).textContent).toContain('Bot permission wasn’t added');
  expect(api.requests.map(request => request.action)).toEqual(['prepare']);
  await userEvent.click(screen.getByRole('button', {name: 'Retry wallet setup'}));
  await waitFor(() => expect(sessionStorage.getItem('slack-tip.pending-link')).toBeNull());
  expect(api.requests.map(request => request.action)).toEqual(['prepare', 'prepare', 'complete']);
});

test('an account change during verification prevents a stale signer grant', async () => {
  openSlackLink();
  authenticate();
  sdk.wallets = [makeWallet('privy', 'embedded')];
  let resolveResponse!: (response: Response) => void;
  const deferred = new Promise<Response>(resolve => { resolveResponse = resolve; });
  const api = mockLinkApi();
  api.fetchMock.mockImplementationOnce(() => deferred);
  const {rerender} = render(<LoginPage />);
  await waitFor(() => expect(api.fetchMock).toHaveBeenCalledTimes(1));
  sdk.authenticated = false;
  sdk.user = null;
  sdk.wallets = [];
  rerender(<LoginPage />);
  await act(async () => resolveResponse(Response.json({signerId: api.signerId, slackUserId: api.slackUserId, hasBotSigner: false, linked: false})));
  expect(sdk.addSigners).not.toHaveBeenCalled();
  expect(api.fetchMock).toHaveBeenCalledTimes(1);
});

test('starts setup when a new Slack link opens on an already-rendered login page', async () => {
  authenticate();
  sdk.wallets = [makeWallet('privy', 'embedded')];
  const api = mockLinkApi({hasBotSigner: true});
  render(<LoginPage />);
  expect(api.fetchMock).not.toHaveBeenCalled();
  const linkToken = randomBytes(32).toString('hex');
  act(() => { window.location.hash = `link=${linkToken}`; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await waitFor(() => expect(sessionStorage.getItem('slack-tip.pending-link')).toBeNull());
  expect(api.requests[0]).toHaveProperty('linkToken', linkToken);
  expect(window.location.hash).toBe('');
});
