// const mysql = require('mysql2');
const mysql = require('mysql2/promise');
const redis = require('redis');
const bluebird = require('bluebird');
const logger = require('../utils/logger');
const moment = require('moment');
require('moment/locale/zh-cn');
const util = require('util');
const PromiseQueue = require('promise-queue');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
moment.locale('zh-cn');

const isDev = process.env.NODE_ENV === 'development';
// const isDev = true;

const log = logger.getLogger(isDev ? 'schedulesDev' : 'schedulesProd');
let dbConf = {};
let redisConf = {};
if (isDev) {
  dbConf = require('../configs/oj-db.dev');
  redisConf = require('../configs/oj-redis.dev');
} else {
  dbConf = require('../configs/oj-db.prod');
  redisConf = require('../configs/oj-redis.prod');
}

const MAX_PARALLEL_TASK_NUM = 2;
const MAX_MYSQL_POOL_CONNECTION = 2;

let conn;
let redisClient;
let pq = new PromiseQueue(MAX_PARALLEL_TASK_NUM, Infinity);

const updateEvery = 10 * 60 * 1000; // 每 10min 更新一次
const maxSolutionNumPerUpdate = 1000000; // 每次更新最大获取的 solution 数

/**
 * run info
 * {
 *   lastSolutionId: number;
 *   _updateEvery: number; // ms
 *   _updatedAt: number; // timestamp (ms)
 * }
 */
const redisRunInfoKey = 'stats:user_accepted_problems_run_info';

/**
 * uap
 * {
 *   accepted: number;
 *   problems: {
 *     pid: number;
 *     sid: number;
 *     at: number; // timestamp (s)
 *   }[];
 *   _updatedAt: number; // timestamp (ms)
 * }
 */
const redisUapKey = 'stats:user_accepted_problems:%d';

/**
 * usp
 * {
 *   accepted: number;
 *   submitted: number;
 *   problems: {
 *     pid: number;
 *     s: {
 *       sid: number;
 *       res: number;
 *       at: number; // timestamp (s)
 *     }[];
 *   }[];
 *   _updatedAt: number; // timestamp (ms)
 * }
 */
const redisUspKey = 'stats:user_submitted_problems:%d';

async function query(sql, params) {
  const SQL = conn.format(sql, params);
  isDev && log.info('[sql.start]', SQL);
  const _start = Date.now();
  const [rows] = await conn.query(SQL);
  isDev && log.info(`[sql.done]  ${Date.now() - _start}ms`);
  return rows;
}

async function findOne(sql, params) {
  const res = await query(sql + ' LIMIT 1', params);
  if (res && res[0]) {
    return res[0];
  }
  return null;
}

async function getRedisKey(key) {
  const res = await redisClient.getAsync(key);
  try {
    return JSON.parse(res);
  } catch (e) {
    return null;
  }
}

function setRedisKey(key, data, expiration) {
  if (expiration) {
    return redisClient.setexAsync(key, expiration, JSON.stringify(data));
  }
  return redisClient.setAsync(key, JSON.stringify(data));
}

function formatTime(momentObj) {
  return momentObj.format('YYYY-MM-DD HH:mm:ss');
}

async function init() {
  if (!conn) {
    // conn = await mysql.createConnection(dbConf);
    conn = await mysql.createPool({
      ...dbConf,
      waitForConnections: true,
      connectionLimit: MAX_MYSQL_POOL_CONNECTION,
      queueLimit: 0,
    });
  }
  if (!redisClient) {
    redisClient = redis.createClient(redisConf);
    redisClient.on('error', function(err) {
      log.error('[redis.error]', err);
    });
  }
}

async function getUserAcceptedProblems() {
  log.info(`[getUserAcceptedProblems.start]`);
  const _start = Date.now();
  await init();

  let result = [];
  const runInfo = await getRedisKey(redisRunInfoKey);
  const lastSolutionId = (runInfo && runInfo.lastSolutionId) || 0;
  result = await findOne('SELECT solution_id FROM solution ORDER BY solution_id DESC');
  const { solution_id: maxSolutionId } = result;
  let newLastSolutionId = Math.min(lastSolutionId + maxSolutionNumPerUpdate, maxSolutionId);

  // // 获取有新增 AC 的用户列表
  // result = await query(
  //   'SELECT DISTINCT(user_id) FROM solution WHERE result=1 and solution_id>? and solution_id<=?',
  //   [lastSolutionId, newLastSolutionId],
  // );
  // 获取有提交的用户列表
  result = await query(
    'SELECT DISTINCT(user_id) FROM solution WHERE result!=0 and result!=12 and result!=11 and result!=7 and solution_id>? and solution_id<=?',
    [lastSolutionId, newLastSolutionId],
  );
  const userIds = result.map((r) => r.user_id);
  log.info(
    `[getUserAcceptedProblems] solutions: [${lastSolutionId +
      1}, ${newLastSolutionId}], submitted users: ${userIds.length}`,
  );

  const queueTasks = [];
  for (const userId of userIds) {
    // 屏蔽非法用户（包括注册比赛用户）
    if (!userId || userId >= 10000000) {
      continue;
    }
    queueTasks.push(
      pq.add(async () => {
        // // 处理每个有新增 AC 的用户的数据
        // const userSolutions = await query(
        //   'SELECT solution_id, problem_id, sub_time FROM solution WHERE result=1 and user_id=?',
        //   [userId],
        // );
        // 处理每个有新增提交的用户的数据
        const userSolutions = await query(
          'SELECT solution_id, problem_id, result, sub_time FROM solution WHERE result!=0 and result!=12 and result!=11 and result!=7 and user_id=?',
          [userId],
        );
        const acceptedProblemsSet = new Set();
        const acceptedProblems = [];
        const submittedProblemSolutionsMap = new Map();
        const submittedProblems = [];
        for (const s of userSolutions) {
          const { solution_id: solutionId, problem_id: problemId, result, sub_time } = s;
          if (acceptedProblemsSet.has(problemId)) {
            continue;
          }
          const submittedProblemSolutions = submittedProblemSolutionsMap.get(problemId) || [];
          const submittedAt = sub_time.getTime() / 1000;
          submittedProblemSolutions.push({
            sid: solutionId,
            res: result,
            at: submittedAt,
          });
          submittedProblemSolutionsMap.set(problemId, submittedProblemSolutions);
          if (result === 1) {
            acceptedProblemsSet.add(problemId);
            acceptedProblems.push({
              pid: problemId,
              sid: solutionId,
              at: submittedAt,
            });
          }
        }
        // 以题目维度整理 USP
        submittedProblemSolutionsMap.forEach((submittedProblemSolutions, problemId) => {
          submittedProblems.push({
            pid: problemId,
            s: submittedProblemSolutions || [],
          });
        });
        // 更新 UAP
        const userAcceptedProblemsData = {
          accepted: acceptedProblems.length,
          problems: acceptedProblems,
          _updatedAt: Date.now(),
        };
        await setRedisKey(util.format(redisUapKey, userId), userAcceptedProblemsData);
        // 更新 USP
        const userSubmittedProblemsData = {
          accepted: acceptedProblems.length,
          submitted: submittedProblems.length,
          problems: submittedProblems,
          _updatedAt: Date.now(),
        };
        await setRedisKey(util.format(redisUspKey, userId), userSubmittedProblemsData);
      }),
    );
  }
  await Promise.all(queueTasks);

  // 更新 run info
  await setRedisKey(redisRunInfoKey, {
    lastSolutionId: newLastSolutionId,
    _updateEvery: updateEvery,
    _updatedAt: _start,
  });

  log.info(`[getUserAcceptedProblems.done] ${Date.now() - _start}ms`);
  return result;
}

async function main() {
  await getUserAcceptedProblems();
}

// main();

module.exports = [
  {
    cron: '2,12,22,32,42,52 * * * *',
    task: getUserAcceptedProblems,
  },
];
