global.loggerCategory = 'oj3-user-a-s-problems';

const util = require('util');
const PromiseQueue = require('promise-queue');
const { logger } = require('../../utils/logger');
const { getOjSqlAgent } = require('../../utils/sql');
const { getOjRedisAgent } = require('../../utils/redis');
const { runMain } = require('../../utils/misc');

const { query } = getOjSqlAgent({ connectionLimit: 2 });
const redisClient = getOjRedisAgent();

const MAX_PARALLEL_TASK_NUM = 2;

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
const redisRunInfoKey = 'stats:user_a_s_problems_run_info';

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

async function getUserASProblems() {
  logger.info(`[getUserASProblems.start]`);
  const _start = Date.now();
  try {
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
    logger.info(
      `[getUserASProblems] solutions: [${
        lastSolutionId + 1
      }, ${newLastSolutionId}], submitted users: ${userIds.length}`,
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

    logger.info(`[getUserASProblems.done] ${Date.now() - _start}ms`);
    return result;
  } catch (e) {
    logger.error(`[getUserASProblems.error]`, e);
  }
}

async function main() {
  await getUserASProblems();
}

logger.info('start');
runMain(main);