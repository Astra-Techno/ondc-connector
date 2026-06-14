const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transport = new winston.transports.DailyRotateFile({
  filename: path.join('logs', 'ondc-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m'
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    transport,
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Separate trace logger for full ONDC request/response payloads
const traceTransport = new winston.transports.DailyRotateFile({
  filename: path.join('logs', 'ondc-trace-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '7d',
  maxSize: '50m'
});

const ondcTraceLogger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [traceTransport]
});

module.exports = logger;
module.exports.ondcTrace = ondcTraceLogger;
