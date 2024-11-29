const path = require('path');

module.exports = [
  {
    cron: '30 4 * * *',
    script: path.resolve(__dirname, 'task.js'),
    args: [],
  },
];
