import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';

const app = createApp();

app.listen(config.port, () => {
  logger.info('BistroBuddies backend listening.', {
    port: config.port,
    deliveryFee: config.deliveryFee,
    allowedOrigins: config.allowedOrigins.length,
  });
});
