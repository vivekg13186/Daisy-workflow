# Example external plugin — reddit.search (SDK-driven).
#
# Build context must be the repo ROOT so the `file:../../plugin-sdk`
# dependency in package.json resolves. docker-compose.plugins.yml
# passes context=. and dockerfile=plugins-external/reddit/Dockerfile.
#
# Resulting image is ~50MB (Node 22 alpine, no transitive deps).

FROM node:22-alpine
WORKDIR /workspace

# Replicate the host's relative directory layout so npm's
# `file:../../plugin-sdk` reference resolves correctly during
# install inside the container.
COPY plugin-sdk                /workspace/plugin-sdk
COPY plugins-external/reddit   /workspace/plugins-external/reddit

WORKDIR /workspace/plugins-external/reddit
RUN npm install --omit=dev

# Drop to a non-root user. node:22-alpine includes a `node` user
# by default with uid/gid 1000.
USER node

EXPOSE 8080
ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["node", "index.js"]
