# MEET 서버 이미지 (Node 22 — 내장 SQLite 사용)
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# DB 는 /data 볼륨에 저장 (컨테이너를 다시 만들어도 유지)
RUN mkdir -p /data && chown node:node /data
USER node
ENV DB_PATH=/data/meet.db PORT=3000 TRUST_PROXY=1
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.js"]
