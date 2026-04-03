import pino from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(level: LogLevel = 'info'): pino.Logger {
  return pino({
    level,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

export const logger = createLogger(
  (process.env.PALISADE_LOG_LEVEL as LogLevel) || 'info',
);
