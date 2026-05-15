# search action — Daisy external plugin
FROM node:22-alpine
WORKDIR /workspace

COPY plugins-external/jira-issue-search/package.json ./
RUN npm install --omit=dev

COPY plugins-external/jira-issue-search/. ./

ENV PORT=8080
EXPOSE 8080
USER node

CMD ["node", "index.js"]
