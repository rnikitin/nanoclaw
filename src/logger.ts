import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr.
// Log but do NOT exit — let the process recover. Only truly unrecoverable
// errors (like corrupted heap) would crash Node anyway.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception (recovered — process stays alive)');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
