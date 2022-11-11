# onlinejudge3-schedules

OJ3 定时任务

### 准备

安装依赖：`npm i`

### 生产环境部署

复制 configs 下的 *.dev.js 为 *.prod.js，修改配置

### 运行

`node index.js` 或通过 pm2 等方式运行

### 定时任务列表

- `oj3-index-stats`：首页排行榜统计
- `oj3-sitemap`：SSG 静态站点页面，用于推送给搜索引擎
- `oj3-user-a-s-problems`：用户 AC、提交题目统计
