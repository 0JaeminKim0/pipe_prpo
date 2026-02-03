# PR→PO 자동화 AI Agent (PoC)

## 프로젝트 개요

조선소 구매팀의 구매요청(PR) → 발주(PO) 프로세스를 AI Agent로 자동화하는 PoC 시스템입니다.

### 목표
- 처리시간 80% 단축
- 92.5% 자동화율 달성 (HITL 7.5%)
- 담당자는 AI 판단결과 검토 및 예외처리만 수행

### 대상 범위 (PoC)
- PZAF (ANCHOR FITTING & LIMIT STOPPER) 배관재
- PR 2,592건, 발주실적 1,802건

---

## 현재 완료된 기능

### ✅ Step 1: PR 업로드
- Excel 파일 드래그 앤 드롭 업로드
- PR 데이터 및 발주실적 파일 자동 분류
- 데이터 검증 및 요약 표시 (PR 건수, 발주실적, PZAF 자재)

### ✅ Step 2: AI 처리
- **데이터 검증**: 필수항목 NULL 체크 (구매요청, 자재번호, 내역, 구매요청일, PR납기일, LEAD_TIME, 소싱그룹, 자재그룹)
- **누락 PR 이메일 발송 준비**: 담당자별 이메일 초안 생성
- **계약 분류**: 표준단가/비표준단가/NA(견적대상) 분류
- **긴급도 산정**: 납기일 기반 긴급(🔴)/일반(🟡)/여유(🟢) 분류
- **업체 매칭**: 과거 발주실적 기반 납품업체 자동 매칭
- **예정가 산정**: 자재+내역 일치 → 그룹 평균 → LLM 산정 → 기본값
- **적정성 검토**: 덤핑의심, 가격경쟁력 검토, HITL 필요 여부 판단

### ✅ Step 3: 견적의뢰 관리
- PR 목록 및 필터링 (긴급도, 처리상태)
- 견적의뢰 상세 정보 조회
- 기본정보, 계약정보, 금액정보, 협력회사, AI 판단 표시
- 개별 승인 처리

### ✅ Step 4: 최종 리포트
- 처리 결과 요약 (자동완료/HITL 검토)
- 긴급도별, 계약방식별 통계
- Excel 다운로드
- SRM 일괄 전송 (시뮬레이션)

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/health` | 서버 상태 확인 |
| POST | `/api/upload` | Excel 파일 업로드 (multipart/form-data) |
| GET | `/api/summary` | 업로드된 데이터 요약 |
| POST | `/api/process` | AI Agent 처리 실행 |
| GET | `/api/results` | 처리 결과 조회 |
| GET | `/api/quotations` | 견적의뢰 목록 |
| PUT | `/api/quotations/:id` | 견적의뢰 수정 |
| POST | `/api/quotations/:id/approve` | 견적의뢰 승인 |
| POST | `/api/quotations/batch-approve` | 일괄 승인 |
| GET | `/api/export` | Excel 내보내기 |
| GET | `/api/emails` | 이메일 로그 조회 |
| GET | `/api/llm-logs` | LLM 호출 로그 조회 |

---

## 기술 스택

| 구분 | 기술 |
|-----|------|
| Backend | Node.js + Express |
| Frontend | HTML + Tailwind CSS + Vanilla JS |
| Excel 처리 | xlsx (SheetJS) |
| LLM | Claude API (claude-sonnet-4-20250514) |
| 배포 | Railway (Docker) |

---

## 로컬 개발

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일에 ANTHROPIC_API_KEY 설정

# 개발 서버 실행
npm run dev

# 또는 직접 실행
node server.js
```

서버 실행 후: http://localhost:3000

---

## Railway 배포

### 1. Railway CLI 설치
```bash
npm install -g @railway/cli
railway login
```

### 2. 프로젝트 생성 및 배포
```bash
railway init
railway up
```

### 3. 환경변수 설정 (Railway Dashboard)
```
ANTHROPIC_API_KEY=your_api_key_here
```

### 4. GitHub 연동 (CI/CD)
1. Railway 대시보드에서 "Connect GitHub" 선택
2. 저장소 선택 및 연결
3. `main` 브랜치 push 시 자동 배포

---

## 데이터 파일 형식

### PR 데이터 (구매요청진행현황.XLSX)
**필수 컬럼:**
- 구매요청
- 자재번호
- 내역
- 구매요청일
- PR납기일
- LEAD_TIME
- 소싱그룹
- 자재그룹

**선택 컬럼:**
- 단가계약번호, 자동배량그룹, 요청수량, UOM, 구매요청자, PR생성형태 등

### 발주실적 (PZAF 발주실적.xlsx)
**필수 컬럼:**
- 자재번호
- 자재내역
- 업체명
- 업체코드
- 발주수량
- 발주금액(KRW)-변환

---

## 미구현 기능 (향후 개발)

1. **실시간 처리 진행률 WebSocket 연동**
2. **SRM 시스템 실제 연동**
3. **이메일 실제 발송**
4. **사용자 인증/권한 관리**
5. **처리 이력 DB 저장**
6. **대시보드 통계 시각화**

---

## 프로젝트 구조

```
webapp/
├── server.js           # Express 서버 + AI Agent 로직
├── public/
│   └── index.html      # 프론트엔드 UI
├── package.json        # 의존성 관리
├── Dockerfile          # Railway 배포용 Docker 설정
├── railway.json        # Railway 배포 설정
├── ecosystem.config.cjs # PM2 설정 (로컬 개발용)
├── .env.example        # 환경변수 예시
├── .gitignore          # Git 제외 파일
└── README.md           # 프로젝트 문서
```

---

## URL

- **Sandbox URL**: https://3000-i4fsvoyvhlxqdr3837cax-b237eb32.sandbox.novita.ai
- **Production URL**: Railway 배포 후 제공

---

## 라이선스

Private - 내부 PoC 용도
