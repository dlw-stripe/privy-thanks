import {ExpressReceiver} from '@slack/bolt';
import express from 'express';
import {resolve} from 'node:path';
import {registerOnboardingRoutes, type OnboardingConfig} from '../onboarding/routes';

/** Create the HTTP receiver for Slack callbacks and the built login page. */
export function createUiReceiver({
  signingSecret,
  frontendDirectory = resolve('ui/dist'),
  onboarding,
}: {
  signingSecret: string;
  frontendDirectory?: string;
  onboarding?: OnboardingConfig;
}) {
  const receiver = new ExpressReceiver({
    signingSecret,
    endpoints: '/slack/events',
  });

  if (onboarding) registerOnboardingRoutes(receiver.router, onboarding);

  // Only the compiled assets are served; source and backend config stay private.
  receiver.router.use(
    '/assets',
    express.static(resolve(frontendDirectory, 'assets'), {
      dotfiles: 'deny',
      index: false,
    }),
  );

  receiver.router.get('/login', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.sendFile(resolve(frontendDirectory, 'index.html'));
  });

  return receiver;
}
