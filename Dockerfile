FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY *.mjs ./

ENV NODE_ENV=production

CMD ["node", "server.mjs"]
