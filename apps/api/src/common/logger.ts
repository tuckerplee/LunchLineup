import winston from 'winston';

/**
 * Structured JSON Logger
 * As per Architecture Part X
 */
export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
    ),
    defaultMeta: { service: 'lunchlineup-api' },
    transports: [
        new winston.transports.Console(),
        // In production, Loki would scrape the console output or a file
    ],
});
