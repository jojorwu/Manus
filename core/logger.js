const winston = require('winston');

// Determine log level from environment variable or default to 'info'
const logLevel = process.env.LOG_LEVEL || 'info';

// Define custom log format
const logFormat = winston.format.printf(({ level, message, timestamp, service, ...metadata }) => {
  let msg = `${timestamp} [${service || 'Application'}] ${level}: ${message} `;
  if (Object.keys(metadata).length > 0) {
    // Only stringify metadata if it's not already a string (e.g. error stack)
    if (typeof metadata === 'object' && metadata !== null) {
        // Special handling for Error objects to ensure message and stack are logged
        if (metadata.stack && metadata.message) {
             msg += `Error: ${metadata.message} Stack: ${metadata.stack}`;
        } else {
            try {
                // Attempt to stringify, catch circular references or other errors
                const metaString = JSON.stringify(metadata, null, 2);
                if (metaString !== '{}') { // Avoid empty object stringification
                    msg += metaString;
                }
            } catch (e) {
                msg += `(Error serializing metadata: ${e.message})`;
            }
        }
    } else if (metadata) {
        msg += metadata; // If metadata is a simple string (e.g. error stack)
    }
  }
  return msg.trim();
});

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize(), // Colorize log levels for console output
    winston.format.errors({ stack: true }), // Log stack traces for Error objects
    logFormat
  ),
  defaultMeta: { service: 'Application' }, // Default service tag, can be overridden
  transports: [
    new winston.transports.Console({
      handleExceptions: true, // Log uncaught exceptions
      handleRejections: true, // Log unhandled promise rejections
    }),
    // Optionally, add a file transport
    // new winston.transports.File({ filename: 'error.log', level: 'error' }),
    // new winston.transports.File({ filename: 'combined.log' }),
  ],
  exitOnError: false, // Do not exit on handled exceptions
});

// Create a stream object with a 'write' function that will be used by morgan (if http logging is needed)
// logger.stream = {
//   write: function(message, encoding) {
//     logger.info(message.trim());
//   },
// };

module.exports = logger;
