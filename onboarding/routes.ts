import express, {type Router} from 'express';
import type {OnboardingStore} from './store';
import {OnboardingError, type VerifiedWallet} from './types';

/** Backend dependencies; private keys never enter browser responses. */
export type OnboardingConfig = {
  store: OnboardingStore;
  publicOrigin: string;
  signerId: string;
  verifyWallet: (input: {accessToken: string; address: string}) => Promise<VerifiedWallet>;
};

/** Register same-origin onboarding without touching Bolt's raw-body middleware. */
export function registerOnboardingRoutes(router: Router, config: OnboardingConfig) {
  router.post('/api/slack-link', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers.origin !== config.publicOrigin) {
      response.status(403).json({error: 'Open the login link in a regular browser.'});
      return;
    }
    next();
  }, express.json({limit: '4kb', strict: true}), async (request, response) => {
    try {
      const body: unknown = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new OnboardingError(400, 'Invalid wallet setup request.');
      }
      const {action, linkToken, walletAddress} = body as Record<string, unknown>;
      if ((action !== 'prepare' && action !== 'complete') ||
          typeof linkToken !== 'string' || typeof walletAddress !== 'string' ||
          !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
        throw new OnboardingError(400, 'Invalid wallet setup request.');
      }
      const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
      if (!bearer) throw new OnboardingError(401, 'Log in again to continue wallet setup.');
      config.store.checkLink(linkToken);
      const wallet = await config.verifyWallet({accessToken: bearer[1], address: walletAddress});
      const identity = action === 'prepare'
        ? config.store.prepareLink(linkToken, wallet)
        : config.store.completeLink(linkToken, wallet);
      response.json({
        ...identity, signerId: config.signerId, hasBotSigner: wallet.hasBotSigner,
        linked: action === 'complete',
      });
    } catch (error) {
      if (error instanceof OnboardingError) {
        response.status(error.status).json({error: error.message});
      } else {
        console.error('Slack wallet linking failed.');
        response.status(500).json({error: 'Couldn’t save the Slack link. Retry wallet setup.'});
      }
    }
  });
  router.use('/api/slack-link', (error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    // Parser errors can contain the submitted body; never log or echo them.
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 400;
    response.status(status).json({error: 'Invalid wallet setup request.'});
  });
}
