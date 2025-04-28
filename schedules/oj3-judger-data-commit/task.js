global.loggerCategory = 'oj3-judger-data-commit';

const path = require('path');
const fs = require('fs-extra');
const util = require('util');
const os = require('os');
const childProcess = require('child_process');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');
const { logger } = require('../../utils/logger');
const { getOjCosAgent } = require('../../utils/cos');
const { isProd } = require('../../utils/env');
const { runMain } = require('../../utils/misc');

const { cos, conf: cosConf } = getOjCosAgent();
const conf = isProd
  ? require('../../configs/oj3-judger-data-commit.prod')
  : require('../../configs/oj3-judger-data-commit.dev');
const remoteDataCommitDir = 'judger/data-commit/';
const remoteDataReleaseDir = 'judger/data-release/';
const git = simpleGit(path.join(process.cwd(), conf.dataPath));

async function downloadCosPrivateFile(url) {
  const res = await cos.getObject({
    Bucket: cosConf.buckets.private.bucket,
    Region: cosConf.buckets.private.region,
    Key: url,
  });
  if (res.statusCode >= 400) {
    throw new Error(`Failed to download COS file: ${res.statusCode} ${res.RequestId}`);
  }
  return res.Body;
}

async function downloadCosPrivateFileTo(url, savePath) {
  const res = await cos.getObject({
    Bucket: cosConf.buckets.private.bucket,
    Region: cosConf.buckets.private.region,
    Key: url,
    Output: fs.createWriteStream(savePath),
  });
  if (res.statusCode >= 400) {
    throw new Error(`Failed to download COS file: ${res.statusCode} ${res.RequestId}`);
  }
}

async function deleteCosPrivateFile(remoteFilePath) {
  await cos.deleteObject({
    Bucket: cosConf.buckets.private.bucket,
    Region: cosConf.buckets.private.region,
    Key: remoteFilePath,
  });
}

async function uploadCosPrivateFile(file, remoteFilePath) {
  await cos.putObject({
    Bucket: cosConf.buckets.private.bucket,
    Region: cosConf.buckets.private.region,
    Key: remoteFilePath,
    Body: file,
  });
}

async function fetchLastCommit() {
  const res = await downloadCosPrivateFile(path.join(remoteDataCommitDir, 'lastcommit'));
  return res.toString('utf-8') || null;
}

async function fetchPendingCommits() {
  const res = await cos.getBucket({
    Bucket: cosConf.buckets.private.bucket,
    Region: cosConf.buckets.private.region,
    Prefix: remoteDataCommitDir,
    Delimiter: '/',
  });
  const contents = res.Contents.filter((item) => item.Key.endsWith('.commit.json'));
  const commitList = contents.map((item) => {
    const commitName = item.Key.replace(remoteDataCommitDir, '');
    const [ts, problemId, dataReleaseFileName] = commitName.replace('.commit.json', '').split('-');
    return {
      commitName,
      problemId: +problemId,
      dataReleaseFileName,
      createdAt: new Date(+ts),
    };
  });
  return commitList;
}

async function fetchCommitFile(commitName) {
  const res = await downloadCosPrivateFile(path.join(remoteDataCommitDir, commitName));
  return JSON.parse(res.toString('utf-8') || '{}');
}

async function checkIsDataGitStatusClean() {
  const res = await git.status();
  if (res.files.length > 0) {
    return false;
  }
  return true;
}

async function pullDataGit() {
  const res = await git.pull('origin', conf.dataGitBranch, { '--no-rebase': null });
  return res;
}

async function main() {
  const pidPath = path.join(__dirname, '../../.pid');
  const pid = await fs
    .readFile(pidPath, 'utf-8')
    .then((r) => +r.trim())
    .catch(() => null);
  if (pid) {
    try {
      logger.info(`oj3-judger-data-commit already running, PID: ${pid}, kill it`);
      process.kill(pid, 9);
      logger.info(`oj3-judger-data-commit last process killed`);
    } catch (e) {
      if (e.code === 'EPERM') {
        logger.error(`Permission denied to kill process with PID ${pid}`);
        process.exit(1);
      } else if (e.code === 'ESRCH') {
        logger.info(`oj3-judger-data-commit last process is ended`);
      } else {
        logger.error(`Unexpected error occurred: ${e.message}`);
      }
    }
  }
  fs.writeFileSync(pidPath, process.pid.toString());

  try {
    const _start = Date.now();
    const lastCommit = await fetchLastCommit();
    const pendingCommits = await fetchPendingCommits();

    if (pendingCommits.length === 0) {
      logger.info(`[oj3-judger-data-commit] no pending commits`);
      return;
    }

    logger.info(`[oj3-judger-data-commit] pending commits: ${pendingCommits.length}`);
    try {
      await git.addConfig('user.name', conf.dataGitUser);
      await git.addConfig('user.email', conf.dataGitEmail);
      await pullDataGit();
      logger.info(`[oj3-judger-data-commit] pre pull data git done`);
    } catch (e) {
      logger.error(
        `[oj3-judger-data-commit] pre pull data git failed, manual processing is required: ${e.message}`,
      );
      throw e;
    }

    for (const commit of pendingCommits) {
      logger.info(`[oj3-judger-data-commit] processing commit: ${commit.commitName}`);
      const { commitName, problemId, dataReleaseFileName } = commit;
      const {
        name = conf.dataGitUser,
        email = conf.dataGitEmail,
        commitMessage = `Update judger data ${problemId} automatically`,
      } = await fetchCommitFile(commitName);
      logger.info(`[oj3-judger-data-commit] got commit file:`, {
        name,
        email,
        commitMessage,
      });
      const remoteDataReleaseFilePath = path.join(
        remoteDataReleaseDir,
        problemId.toString(),
        dataReleaseFileName,
      );
      const dataReleaseTmpPath = path.join(
        os.tmpdir(),
        'oj3-judger-data-commit',
        `${problemId}_${dataReleaseFileName}`,
      );
      fs.ensureFileSync(dataReleaseTmpPath);
      logger.info(
        `[oj3-judger-data-commit] download data release "cos:${remoteDataReleaseFilePath}" to "${dataReleaseTmpPath}"`,
      );
      await downloadCosPrivateFileTo(remoteDataReleaseFilePath, dataReleaseTmpPath);
      logger.info(
        `[oj3-judger-data-commit] downloaded data release, file size: ${
          fs.statSync(dataReleaseTmpPath).size
        }`,
      );

      // check git status
      const isClean = await checkIsDataGitStatusClean();
      if (!isClean) {
        logger.info(`[oj3-judger-data-commit] git status is not clean, commit all and push`);
        // await git.addConfig('user.name', conf.dataGitUser);
        // await git.addConfig('user.email', conf.dataGitEmail);
        await git.add('./*');
        await git.commit(commitMessage, {
          '--author': `${conf.dataGitUser} <${conf.dataGitEmail}>`,
        });
        await git.push('origin', conf.dataGitBranch);
      } else {
        logger.info(`[oj3-judger-data-commit] git status is clean, no need to commit`);
      }

      // unzip data release file
      const targetPath = path.join(process.cwd(), conf.dataPath, 'data', problemId.toString());
      logger.info(`[oj3-judger-data-commit] unzip "${dataReleaseTmpPath}" to "${targetPath}"`);
      const zip = new AdmZip(dataReleaseTmpPath);
      await fs.remove(targetPath);
      await fs.ensureDir(targetPath);
      zip.extractAllTo(targetPath, true);
      logger.info(`[oj3-judger-data-commit] unzip ${dataReleaseTmpPath} done, remove tmp file`);
      await fs.remove(dataReleaseTmpPath);

      // commit and push
      logger.info(`[oj3-judger-data-commit] commit ${problemId}:`, {
        name,
        email,
        commitMessage,
      });
      // await git.addConfig('user.name', name);
      // await git.addConfig('user.email', email);
      await git.add(`data/${problemId}`);
      await git.commit(commitMessage, `data/${problemId}`, {
        '--author': `"${name} <${email}>"`,
      });
      logger.info(`[oj3-judger-data-commit] commit ${problemId} done`);
      await git.push('origin', conf.dataGitBranch);
      logger.info(`[oj3-judger-data-commit] push ${problemId} done`);

      // update remote cos
      logger.info(
        `[oj3-judger-data-commit] delete commit file: "cos:${path.join(
          remoteDataCommitDir,
          commitName,
        )}"`,
      );
      await deleteCosPrivateFile(path.join(remoteDataCommitDir, commitName));
      logger.info(
        `[oj3-judger-data-commit] update lastcommit: "cos:${path.join(
          remoteDataCommitDir,
          'lastcommit',
        )}"`,
      );
      await uploadCosPrivateFile(
        Buffer.from(`${commitName}`, 'utf-8'),
        path.join(remoteDataCommitDir, 'lastcommit'),
      );
      logger.info(`[oj3-judger-data-commit] finished commit`);
    }

    logger.info(`[oj3-judger-data-commit] done, ${Date.now() - _start}ms`);
  } catch (e) {
    logger.error(`[oj3-judger-data-commit] error: ${e.message}`);
    throw e;
  } finally {
    fs.removeSync(pidPath);
  }
}

runMain(main);
