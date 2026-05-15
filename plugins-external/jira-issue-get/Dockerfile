# jira.issue.get — Daisy external plugin
#
# Self-contained. Pulls @daisy-workflow/plugin-sdk from npm; no repo-root
# build context needed.

FROM node:22-alpine
WORKDIR /workspace

COPY plugins-external/jira-issue-get/package.json ./
RUN npm install --omit=dev

COPY plugins-external/jira-issue-get/. ./

ENV PORT=8080
EXPOSE 8080
USER node

CMD ["node", "index.js"]
