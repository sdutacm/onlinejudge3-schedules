const schedule = require('node-schedule');
const oj3IndexStats = require('./schedules/oj3-index-stats');
const oj3Sitemap = require('./schedules/oj3-sitemap');
const getUserASProblems = require('./schedules/oj3-user-a-s-problems');

oj3IndexStats.forEach((t) => {
  schedule.scheduleJob(t.cron, t.task);
});
oj3Sitemap.forEach((t) => {
  schedule.scheduleJob(t.cron, t.task);
});
getUserASProblems.forEach((t) => {
  schedule.scheduleJob(t.cron, t.task);
});
