const path = require('path');

module.exports = [
  {
    cron: '2,12,22,32,42,52 * * * *',
    script: path.resolve(__dirname, 'task.js'),
    args: [],
  },
];
