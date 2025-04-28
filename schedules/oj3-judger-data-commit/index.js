const path = require('path');

module.exports = [
  {
    cron: '*/10 * * * *',
    script: path.resolve(__dirname, 'task.js'),
    args: [],
  },
];
