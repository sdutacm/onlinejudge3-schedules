const path = require('path');

module.exports = [
  {
    cron: '36 * * * *',
    script: path.resolve(__dirname, 'task.js'),
    args: ['day'],
  },
  {
    cron: '39 1,7,13,19 * * *',
    script: path.resolve(__dirname, 'task.js'),
    args: ['week'],
  },
  {
    cron: '0 4 * * *',
    script: path.resolve(__dirname, 'task.js'),
    args: ['month'],
  },
];
