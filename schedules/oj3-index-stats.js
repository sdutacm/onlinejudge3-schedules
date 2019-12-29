// const mysql = require('mysql2');
const mysql = require('mysql2/promise');
const redis = require("redis");
const logger = require('../utils/logger');
const moment = require('moment');
require('moment/locale/zh-cn');

moment.locale('zh-cn');

const isDev = process.env.NODE_ENV === 'development';
// const isDev = true;

const log = logger.getLogger(isDev ? 'schedulesDev' : 'schedulesProd');
let dbConf = {};
if (isDev) {
  dbConf = require('../configs/oj-db.dev');
} else {
  dbConf = require('../configs/oj-db.prod');
}

let conn;
let redisClient;

async function query(sql, params) {
  const SQL = conn.format(sql, params);
  // isDev && log.info('[sql.start]', SQL);
  const _start = Date.now();
  const [rows] = await conn.query(SQL);
  // isDev && log.info(`[sql.done]  ${Date.now() - _start}ms`);
  return rows;
}

function formatTime(momentObj) {
  return momentObj.format('YYYY-MM-DD HH:mm:ss');
}

async function init() {
  if (!conn) {
    conn = await mysql.createConnection(dbConf);
  }
  if (!redisClient) {
    redisClient = redis.createClient();
    redisClient.on('error', function (err) {
      log.error('[redis.error]', err);
    });
  }
}

async function getUserACRank(startAt, type, updateEvery) {
  log.info(`[getUserACRank.start] [${type}]`, startAt);
  const _start = Date.now();
  await init();

  let result = []

  // startAt = '2018-09-28 00:00:00'; // tmp
  const startSolutionRes = await query(`SELECT solution_id FROM solution WHERE sub_time>=? LIMIT 1`, [startAt]);
  if (!startSolutionRes.length) {
    log.warn(`[getUserACRank] [${type}]`, 'no solutions found');
  } else {
    const startSolutionId = startSolutionRes[0].solution_id;
    const solutions = await query(`SELECT solution_id, problem_id, user_id, sub_time FROM solution WHERE result=1 AND solution_id>=?`, [startSolutionId]);
    log.info(`[getUserACRank] [${type}] solutions:`, solutions.length);
    const uMap = new Map();
    for (const solution of solutions) {
      const {
        solution_id: solutionId,
        user_id: userId,
        problem_id: problemId,
        sub_time: createdAt
      } = solution;
      if (!uMap.has(userId)) {
        uMap.set(userId, new Set());
      }
      const pSet = uMap.get(userId);
      pSet.add(problemId);
    }
    // log.info(uMap);
    // log.info('users', Array.from(uMap.keys()).length);
    for (const [userId, pSet] of uMap) {
      // log.info(userId, pSet);
      // 查询每个题目是否之前被 AC 过
      const problems = Array.from(pSet.values());
      for (const problemId of problems) {
        const isACRes = await query(`SELECT solution_id FROM solution WHERE user_id=? AND problem_id=? AND result=1 AND solution_id<? LIMIT 1`, [userId, problemId, startSolutionId]);
        if (isACRes.length) {
          pSet.delete(problemId);
        }
      }
    }
    result = Array.from(uMap.keys())
      .map(userId => ({
        userId,
        problems: Array.from(uMap.get(userId).values()),
      }))
      .filter(item => item.problems.length > 0);
    result.sort((a, b) => {
      return b.problems.length - a.problems.length;
    })
    // log.info('result', result);
  }
  
  // 存入 redis
  topResult = result.slice(0, 20);
  const key = `stats:user_ac:${type}`;
  redisClient.set(key, JSON.stringify({
    count: topResult.length,
    rows: topResult.map(r => ({
      userId: r.userId,
      accepted: r.problems.length,
    })),
    truncated: 20,
    startAt,
    _updateEvery: updateEvery,
    _updatedAt: Date.now(),
  }));

  log.info(`[getUserACRank.done] [${type}] ${Date.now() - _start}ms`);
  return result;
}

async function main() {
  const currentDay = moment().startOf('day');
  const currentWeek = moment().startOf('week');
  const currentMonth = moment().startOf('month');

  await getUserACRank(formatTime(currentDay), 'day', 60 * 60 * 1000);
}

// main();

function genTask(type) {
  switch (type) {
    case 'day':
      return () => getUserACRank(formatTime(moment().startOf('day')), 'day', 60 * 60 * 1000);
    case 'week':
      return () => getUserACRank(formatTime(moment().startOf('week')), 'week', 6 * 60 * 60 * 1000);
    case 'month':
      return () => getUserACRank(formatTime(moment().startOf('month')), 'month', 24 * 60 * 60 * 1000);
  }
}

module.exports = [
  {
    cron: '36 * * * *',
    task: genTask('day'),
  },
  {
    cron: '39 1,7,13,19 * * *',
    task: genTask('week'),
  },
  {
    cron: '0 4 * * *',
    task: genTask('month'),
  },
];
