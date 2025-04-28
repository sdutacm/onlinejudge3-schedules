const COS = require('cos-nodejs-sdk-v5');
const { isProd } = require('./env');

const TIMEOUT = 5 * 60 * 1000;

function getOjCosAgent() {
  const config = isProd ? require('../configs/oj-cos.prod') : require('../configs/oj-cos.dev');

  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    Domain: config.domain,
    Timeout: TIMEOUT,
  });

  return {
    conf: config,
    cos,
  };
}

module.exports = {
  getOjCosAgent,
};
