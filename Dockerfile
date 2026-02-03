# PR→PO 자동화 AI Agent
# Railway 배포용 Dockerfile

FROM node:18-alpine

WORKDIR /app

# 패키지 파일 복사 및 설치
COPY package*.json ./
RUN npm ci --only=production

# 앱 코드 복사
COPY . .

# 포트 노출
EXPOSE 3000

# 환경변수 설정 (Railway에서 오버라이드됨)
ENV NODE_ENV=production
ENV PORT=3000

# 서버 시작
CMD ["node", "server.js"]
