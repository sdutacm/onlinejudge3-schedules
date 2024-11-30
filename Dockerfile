FROM sdutacm/nodebase:16.15.0

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY .node-version ./
COPY ecosystem.config.js ./
COPY index.js ./
COPY configs ./configs
COPY scripts ./scripts
COPY utils ./utils
COPY schedules ./schedules
RUN npm ci

ENV PATH="/app/node_modules/pm2/bin:${PATH}"
CMD npm start
