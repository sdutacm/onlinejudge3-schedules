FROM sdutacm/nodebase:16.15.0

WORKDIR /app

COPY . .
RUN npm ci

ENV PATH="/app/node_modules/pm2/bin:${PATH}"
CMD npm start
