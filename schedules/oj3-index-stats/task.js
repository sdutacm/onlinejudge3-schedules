global.loggerCategory = 'oj3-index-stats';

const { logger } = require('../../utils/logger');
const { getOjSqlAgent } = require('../../utils/sql');
const { getOjRedisAgent } = require('../../utils/redis');
const { moment, formatTime } = require('../../utils/datetime');
const { runMain } = require('../../utils/misc');

const { query } = getOjSqlAgent();
const redisClient = getOjRedisAgent();

async function getUserACRank(startAt, type, updateEvery) {
  logger.info(`[getUserACRank.start] [${type}]`, startAt);
  const _start = Date.now();
  try {
    let result = [];

    // startAt = '2018-09-28 00:00:00'; // tmp
    const startSolutionRes = await query(
      `SELECT solution_id FROM solution WHERE sub_time>=? LIMIT 1`,
      [startAt],
    );
    if (!startSolutionRes.length) {
      logger.warn(`[getUserACRank] [${type}]`, 'no solutions found');
    } else {
      const startSolutionId = startSolutionRes[0].solution_id;
      const solutions = await query(
        `SELECT solution_id, problem_id, user_id, sub_time FROM solution WHERE result=1 AND user_id<10000000 AND solution_id>=?`,
        [startSolutionId],
      );
      logger.info(`[getUserACRank] [${type}] solutions:`, solutions.length);
      const uMap = new Map();
      for (const solution of solutions) {
        const {
          solution_id: solutionId,
          user_id: userId,
          problem_id: problemId,
          sub_time: createdAt,
        } = solution;
        if (!uMap.has(userId)) {
          uMap.set(userId, new Set());
        }
        const pSet = uMap.get(userId);
        pSet.add(problemId);
      }
      // logger.info(uMap);
      // logger.info('users', Array.from(uMap.keys()).length);
      for (const [userId, pSet] of uMap) {
        // logger.info(userId, pSet);
        // 查询每个题目是否之前被 AC 过
        const problems = Array.from(pSet.values());
        for (const problemId of problems) {
          const isACRes = await query(
            `SELECT solution_id FROM solution WHERE user_id=? AND problem_id=? AND result=1 AND solution_id<? LIMIT 1`,
            [userId, problemId, startSolutionId],
          );
          if (isACRes.length) {
            pSet.delete(problemId);
          }
        }
      }
      result = Array.from(uMap.keys())
        .map((userId) => ({
          userId,
          problems: Array.from(uMap.get(userId).values()),
        }))
        .filter((item) => item.problems.length > 0);
      result.sort((a, b) => {
        return b.problems.length - a.problems.length;
      });
      // logger.info('result', result);
    }

    // 存入 redis
    const topResult = result.slice(0, 20);
    const key = `stats:user_ac:${type}`;
    redisClient.set(
      key,
      JSON.stringify({
        count: topResult.length,
        rows: topResult.map((r) => ({
          userId: r.userId,
          accepted: r.problems.length,
        })),
        truncated: 20,
        startAt,
        _updateEvery: updateEvery,
        _updatedAt: Date.now(),
      }),
    );

    logger.info(`[getUserACRank.done] [${type}] ${Date.now() - _start}ms`);
    return result;
  } catch (e) {
    logger.error(`[getUserACRank.error] [${type}]`, e);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    logger.error('Usage: node task.js [day|week|month]');
    return;
  }
  const type = args[0];
  switch (type) {
    case 'day': {
      await getUserACRank(formatTime(moment().startOf('day')), 'day', 60 * 60 * 1000);
      break;
    }
    case 'week': {
      await getUserACRank(formatTime(moment().startOf('week')), 'week', 6 * 60 * 60 * 1000);
      break;
    }
    case 'month': {
      await getUserACRank(formatTime(moment().startOf('month')), 'month', 24 * 60 * 60 * 1000);
      break;
    }
    default: {
      throw new Error(`invalid type ${type}`);
    }
  }
}

logger.info('start');
runMain(main);
