# PR→PO 자동화 AI Agent (PoC)

## 프로젝트 개요

조선소 구매팀의 구매요청(PR) → 발주(PO) 프로세스를 AI Agent로 자동화하는 PoC 시스템입니다.

### 목표
- 처리시간 80% 단축
- 92.5% 자동화율 달성 (HITL 7.5%)
- 담당자는 AI 판단결과 검토 및 예외처리만 수행

### 대상 범위
- PZAF (ANCHOR FITTING & LIMIT STOPPER) 배관재
- PR 2,592건, 발주실적 1,802건

## 기능

### 1. PR 업로드 (Step 1)
- Excel 파일 드래그 앤 드롭 업로드
- PR 데이터 및 발주실적 파일 지원
- 데이터 검증 및 요약 표시

### 2. AI 처리 (Step 2)
- **데이터 검증**: 필수항목 NULL 체크
- **계약 분류**: 표준단가/비표준단가/NA(견적대상)
- **긴급도 산정**: 납기일 기반 긴급/일반/여유 분류
- **업체 매칭**: 과거 발주실적 기반 납품업체 매칭
- **예정가 산정**: 발주실적 기반 + LLM 활용
- **적정성 검토**: 덤핑/가격경쟁력 검토

### 3. 견적의뢰 관리 (Step 3)
- PR 목록 및 필터링 (긴급도, 처리상태)
- 견적의뢰 상세 정보 조회/수정
- 개별 승인 처리

### 4. 최종 리포트 (Step 4)
- 처리 결과 요약
- Excel 다운로드
- SRM 일괄 전송 (시뮬레이션)

## 기술 스택

| 구분 | 기술 |
|-----|------|
| Backend | Node.js + Express |
| Frontend | HTML + Tailwind CSS + Vanilla JS |
| LLM | Claude API (claude-sonnet-4-20250514) |
| 배포 | Railway |

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | /api/health | 서버 상태 확인 |
| POST | /api/upload | 파일 업로드 |
| GET | /api/summary | 데이터 요약 |
| POST | /api/process | AI 처리 실행 |
| GET | /api/results | 처리 결과 조회 |
| GET | /api/quotations | 견적의뢰 목록 |
| PUT | /api/quotations/:id | 견적의뢰 수정 |
| POST | /api/quotations/:id/approve | 견적의뢰 승인 |
| POST | /api/quotations/batch-approve | 일괄 승인 |
| GET | /api/export | Excel 내보내기 |

## 로컬 개발

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일에 ANTHROPIC_API_KEY 설정

# 개발 서버 실행
npm run dev
```

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

### 3. 환경변수 설정
Railway 대시보드에서 다음 환경변수 설정:
- `ANTHROPIC_API_KEY`: Claude API 키

### 4. GitHub 연동 (CI/CD)
1. Railway 대시보드에서 "Connect GitHub" 선택
2. 저장소 선택 및 연결
3. main 브랜치 push 시 자동 배포

## 사용법

1. **파일 업로드**
   - PR 데이터 파일 (구매요청진행현황.XLSX)
   - 발주실적 파일 (PZAF 발주실적.xlsx)

2. **AI 처리 시작**
   - "AI 처리 시작" 버튼 클릭
   - 실시간 처리 현황 확인

3. **결과 검토**
   - 견적의뢰 관리에서 상세 내용 확인
   - 검토필요 건 처리
   - 승인 및 SRM 전송

## 데이터 파일 형식

### PR 데이터 (구매요청진행현황)
필수 컬럼:
- 구매요청
- 자재번호
- 내역
- 구매요청일
- PR납기일
- LEAD_TIME
- 소싱그룹
- 자재그룹

### 발주실적 (PZAF 발주실적)
필수 컬럼:
- 자재번호
- 자재내역
- 업체명
- 업체코드
- 발주수량
- 발주금액(KRW)-변환

## 라이선스

Private - 내부 PoC 용도
