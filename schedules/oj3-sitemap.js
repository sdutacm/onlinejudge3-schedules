// const mysql = require('mysql2');
const mysql = require('mysql2/promise');
const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const logger = require('../utils/logger');

const OJ3_BASE = 'https://acm.sdut.edu.cn/onlinejudge3';
// const OJ3_BASE = 'http://localhost:8102/onlinejudge3';

const isDev = process.env.NODE_ENV === 'development';
// const isDev = true;

const log = logger.getLogger(isDev ? 'schedulesDev' : 'schedulesProd');
let dbConf = {};
let siteMapDir = '';
if (isDev) {
  dbConf = require('../configs/oj-db.dev');
  sitemapConf = require('../configs/oj3-sitemap.dev');
  prerenderConf = require('../configs/oj3-prerender.dev');
} else {
  dbConf = require('../configs/oj-db.prod');
  sitemapConf = require('../configs/oj3-sitemap.prod');
  prerenderConf = require('../configs/oj3-prerender.prod');
}

let conn;

async function query(sql, params) {
  const SQL = conn.format(sql, params);
  isDev && log.info('[sql.start]', SQL);
  const _start = Date.now();
  const [rows] = await conn.query(SQL);
  isDev && log.info(`[sql.done]  ${Date.now() - _start}ms`);
  return rows;
}

async function init() {
  if (!conn) {
    conn = await mysql.createConnection(dbConf);
  }
}

async function genSitemap() {
  log.info('[genSitemap.start]');
  const _start = Date.now();
  await init();

  const problemIds = (await query(`SELECT problem_id FROM problem WHERE display=?`, [1])).map(r => r.problem_id);
  fs.ensureFileSync(sitemapConf.problems);
  fs.writeFileSync(sitemapConf.problems, problemIds.map(id => `${OJ3_BASE}/problems/${id}`).join('\n'));
  const topicIds = (await query(`SELECT topic_id FROM topic`)).map(r => r.topic_id);
  fs.ensureFileSync(sitemapConf.topics);
  fs.writeFileSync(sitemapConf.posts, topicIds.map(id => `${OJ3_BASE}/topics/${id}`).join('\n'));
  const postIds = (await query(`SELECT news_id FROM news WHERE display=?`, [1])).map(r => r.news_id);
  fs.ensureFileSync(sitemapConf.posts);
  fs.writeFileSync(sitemapConf.posts, postIds.map(id => `${OJ3_BASE}/posts/${id}`).join('\n'));

  log.info(`[genSitemap.done] ${Date.now() - _start}ms`);
}

async function prerender() {
  log.info('[prerender.start]');
  const _start = Date.now();

  const urls = [
    ...fs.readFileSync(sitemapConf.problems).toString().split('\n').filter(url => url),
    ...fs.readFileSync(sitemapConf.topics).toString().split('\n').filter(url => url),
    ...fs.readFileSync(sitemapConf.posts).toString().split('\n').filter(url => url),
  ];

  const opt = {
    // headless: false,
    defaultViewport: {
      width: 412,
      height: 732,
    },
  };
  if (!isDev) {
    opt.args = ['--no-sandbox', '--disable-setuid-sandbox'];
  }
  const browser = await puppeteer.launch(opt);
  try {
    const ua = 'Mozilla/5.0 (compatible; sdutacmbot/0.1; +https://acm.sdut.edu.cn/)';
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setUserAgent(ua);
    await page.goto(`${OJ3_BASE}/blank`);
    await page.waitForSelector('.content-loaded');
    for (const url of urls) {
      log.info('[prerender]', url);
      const relativeUrlRegRes = /onlinejudge3(\S+)/.exec(url) || [];
      const relativeUrl = relativeUrlRegRes[1];
      const regRes = /onlinejudge3\/(\w+)\/(\w+)/.exec(url) || [];
      const module = regRes[1];
      const id = +regRes[2];
      if (!relativeUrl || !module || !prerenderConf[module] || !id) {
        throw Error(`invalid url ${url}`);
      }
      // await page.goto(url);
      await page.evaluate((relativeUrl) => {
        _router.replace(relativeUrl);
      }, relativeUrl)
      // await page.waitFor(200);
      await page.waitForSelector('.content-loaded');
      await page.evaluate(() => {
        document.querySelectorAll('script').forEach(elm => elm.remove());
      })
      const html = await page.content();
      fs.ensureDirSync(prerenderConf[module]);
      fs.writeFileSync(path.join(prerenderConf[module], `${id}.html`), html);
      // break;
    }
  } catch (e) {
    log.error('[prerender.error]', e);
    await browser.close();
  }

  log.info(`[prerender.done] ${Date.now() - _start}ms`);
}

async function genSitemapAndPrerender() {
  await genSitemap();
  await prerender();
}

async function main() {
  await genSitemapAndPrerender();
}

// main();

module.exports = [
  {
    cron: '30 4 * * *',
    task: genSitemapAndPrerender,
  },
];
