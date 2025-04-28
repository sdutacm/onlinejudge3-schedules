const log4js = require('log4js');
const { isProd } = require('./env');

const config = isProd ? require('../configs/schedules.prod') : require('../configs/schedules.dev');
const schedules = config.schedules;

const options = {
  appenders: {
    console: {
      type: 'console',
    },
    file: {
      type: 'file',
      filename: 'logs/log.log',
    },
  },
  categories: {
    default: {
      appenders: ['console', 'file'],
      level: 'info',
    },
    dev: {
      appenders: ['console'],
      level: 'info',
    },
    prod: {
      appenders: ['console', 'file'],
      level: 'info',
    },
  },
};

for (const schedule of schedules) {
  options.appenders[`file-${schedule}`] = {
    type: 'file',
    filename: `logs/${schedule}.log`,
  };
  options.categories[schedule] = {
    appenders: ['console', `file-${schedule}`],
    level: 'info',
  };
}

log4js.configure(options);

function getDefaultLogger() {
  return log4js.getLogger(isProd ? 'prod' : 'dev');
}

function getCategoryLogger(schedule) {
  return log4js.getLogger(schedule);
}

const logger = global.loggerCategory
  ? getCategoryLogger(global.loggerCategory)
  : getDefaultLogger();

module.exports = {
  logger,
  getDefaultLogger,
  getCategoryLogger,
};
