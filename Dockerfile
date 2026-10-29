# 한 줄 데스크 운영 이미지(10/29 배포 준비 회의 A1·A2·A3). 서버와 웹 화면 파일을 한 이미지에 같은 판으로 담아요.
#   만들기: docker build --build-arg DESK_BUILD=$(git rev-parse --short HEAD) -t one-line-desk .
#   띄우기: docker run --read-only --tmpfs /tmp --stop-timeout 50 -p 3190:3190 --env-file <비밀 저장소에서 만든 파일> one-line-desk
#   멈춤 유예는 50초 이상이에요(서버가 45초 안에 받던 요청·보관 회차를 끝내요). 살아 있음은 /health/live, 받을 준비는 /health/ready예요.
#   마이그레이션 잡(운영): 같은 이미지로 node --import tsx apps/server/scripts/migrate.ts
#   시연(DESK_MOCK_LOGIN=true, DB 없이 PGlite): --tmpfs /app/.data:uid=1000,gid=1000 을 더해요. 끄면 자료가 사라져요.
# 운영은 .env를 읽지 않아요. 값은 모두 프로세스 환경으로 넣어요(config.ts).

# Node 판은 .node-version과 맞춰요. 사내 레지스트리에 올릴 때는 digest(@sha256:…)로 고정해요.
ARG NODE_VERSION=24.18.0
# 떠 있는 판(보통 커밋). 웹 빌드와 서버가 같은 값을 가져서, 오래 연 옛 화면이 새 판을 알아채요(배포 준비 회의 D1).
ARG DESK_BUILD=dev

# 1) 웹 화면 만들기: 개발 의존성까지 깔고 apps/web/dist를 만들어요.
FROM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG DESK_BUILD
RUN DESK_BUILD=${DESK_BUILD} npm run build -w @one-line-desk/web

# 2) 실행 의존성만 깔기(--omit=dev): tsx는 실행에 써서 들어가고, react·vite·vitest는 빠져요.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund

# 3) 실행 이미지: 파일은 root 소유(읽기만), 프로세스는 node 사용자예요.
FROM node:${NODE_VERSION}-bookworm-slim
ARG DESK_BUILD
ENV NODE_ENV=production DESK_BUILD=${DESK_BUILD}
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/server/node_modules apps/server/node_modules
COPY package.json ./
COPY packages/shared packages/shared
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/scripts apps/server/scripts
COPY db/migrations db/migrations
COPY --from=web /app/apps/web/dist apps/web/dist
# 시연 배포의 PGlite 자리. 운영(DATABASE_URL)은 쓰지 않아요. 읽기 전용 루트로 띄우면 이 자리에 tmpfs를 붙여요.
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3190
# 살아 있음만 봐요(DB를 보지 않아요). DB가 잠깐 흔들려도 재시작(= 모두 로그아웃)이 이어지지 않게 해요(A5).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3190/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# npm·tsx 명령이 감싸지 않게 node를 PID 1로 직접 띄워요. 그래야 SIGTERM이 서버에 바로 가요.
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
