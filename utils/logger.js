const log4js = require('log4js');

log4js.configure({
  appenders: {
    console: {
      type: 'console',
    },
    file: {
      type: 'file',
      filename: 'logs/log.log',
    },
    schedulesFile: {
      type: 'file',
      filename: 'logs/schedules.log',
    },
  },
  categories: {
    default: {
      appenders: ['console', 'file'],
      level: 'info'
    },
    schedulesDev: {
      appenders: ['console'],
      level: 'info'
    },
    schedulesProd: {
      appenders: ['console', 'schedulesFile'],
      level: 'info'
    },
  }
});

module.exports = log4js;
