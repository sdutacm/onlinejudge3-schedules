const path = require('path');
const execa = require('execa');
const schedule = require('node-schedule');
const { isProd } = require('./utils/env');
const config = isProd ? require('./configs/schedules.prod') : require('./configs/schedules.dev');
const schedules = config.schedules;

function genTask(script, args) {
  return () =>
    execa.node(script, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      shell: true,
    });
}

for (const scheduleName of schedules) {
  const scheduleJobs = require(path.join(__dirname, 'schedules', scheduleName));
  scheduleJobs.forEach((t) => {
    schedule.scheduleJob(t.cron, genTask(t.script, t.args));
  });
}
