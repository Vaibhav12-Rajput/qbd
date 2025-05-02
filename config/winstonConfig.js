const path = require("path");
const fs = require("fs");
const { createLogger, format, transports } = require("winston");
const { combine, timestamp, errors, printf, splat, simple } = format;
const DailyRotateFile = require("winston-daily-rotate-file");

const combineFormat = combine(
    splat(),
    simple(),
    errors({ stack: true }),
    timestamp(),
    printf((info) => {
        if (info.stack) {
            return `[${info.level}] ${info.timestamp} : ${info.message} - ${info.stack}`;
        }
        return `[${info.level}] ${info.timestamp} : ${info.message}`;
    })
);

const logsDirectory = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDirectory)) {
    fs.mkdirSync(logsDirectory);
}

const dailyRotateErrorTransport = new DailyRotateFile({
    level: 'error',
    format: combineFormat,
    dirname: logsDirectory,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '1m', // Set the maximum size of a log file before it's rotated
    maxFiles: '30d', // Retain logs for the last 30 days
});

const dailyRotateCombinedTransport = new DailyRotateFile({
    level: 'debug',
    format: combineFormat,
    dirname: logsDirectory,
    filename: 'combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '1m', // Set the maximum size of a log file before it's rotated
    maxFiles: '30d', // Retain logs for the last 30 days
});

const logger = createLogger({
    level: "debug",
    format: combineFormat,
    transports: [
        dailyRotateErrorTransport,
        dailyRotateCombinedTransport,
        new transports.Console({
            format: combineFormat
        }),
    ],
});

module.exports = { logger };
