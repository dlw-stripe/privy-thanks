import {ExpressReceiver} from '@slack/bolt';
import express from 'express';
import {resolve} from 'node:path';

/** Create the HTTP receiver for Slack callbacks and the built login page. */
export function createUiReceiver({
  signingSecret,
  frontendDirectory = resolve('ui/dist'),
}: {
  signingSecret: string;
  frontendDirectory?: string;
}) {
  const receiver = new ExpressReceiver({
    signingSecret,
    endpoints: '/slack/events',
  });

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
    response.sendFile(resolve(frontendDirectory, 'index.html'));
  });

  return receiver;
}
