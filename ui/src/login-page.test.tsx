import {StrictMode} from 'react';
import {randomBytes, randomUUID} from 'node:crypto';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {LoginPage} from './login-page';

type TestUser = {google: {email: string}};
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
  callbacks: {} as {onError?: (code: string) => void; onComplete?: () => void},
}));

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({ready: sdk.ready, authenticated: sdk.authenticated, user: sdk.user, logout: sdk.logout}),
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
  sdk.user = {google: {email: `${randomUUID()}@example.test`}};
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
  expect(screen.getByText('This wallet is not linked to Slack yet.')).toBeTruthy();
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
