const schedule = require('node-schedule');
const oj3IndexStats = require('./schedules/oj3-index-stats');

oj3IndexStats.forEach(t => {
  schedule.scheduleJob(t.cron, t.task);
});
