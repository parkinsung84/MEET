# MEET 서버 이미지 (Node 22 — 내장 SQLite 사용)
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# DB 는 /data 볼륨(또는 Render 디스크)에 저장 — 컨테이너를 다시 만들어도 유지
# 시작 스크립트가 데이터 폴더 권한을 맞춘 뒤 node 사용자로 권한을 낮춰 실행한다
RUN mkdir -p /data && chown node:node /data && chmod +x scripts/docker-entrypoint.sh
ENV DB_PATH=/data/meet.db PORT=3000 TRUST_PROXY=1
EXPOSE 3000
ENTRYPOINT ["scripts/docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.js"]
