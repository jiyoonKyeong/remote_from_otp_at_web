FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# 관리자 권한 없이 실행
USER node

EXPOSE 8080
CMD ["node", "src/server.js"]
