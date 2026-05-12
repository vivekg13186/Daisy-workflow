FROM node:22-alpine

WORKDIR /workspace

# Copy plugin-sdk
COPY plugin-sdk ./plugin-sdk

# Copy the plugin
COPY plugins-external/devvit.reddit ./devvit.reddit

WORKDIR /workspace/devvit.reddit

RUN npm install --omit=dev

USER node

CMD ["node", "index.js"]
