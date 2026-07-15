/**
 * PR→PO 자동화 AI Agent 서버
 * Railway 배포용 Node.js + Express 서버
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// Anthropic Claude API
let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
  try {
    Anthropic = require('anthropic').default;
  } catch (e2) {
    console.log('Anthropic SDK not loaded, using fetch fallback');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// Global state
let globalState = {
  prData: [],
  poHistory: [],
  drawingsData: null,  // 도면 데이터
  processingResults: null,
  llmLogs: [],
  emailLogs: [],
  processingStatus: {
    step: 0,
    totalSteps: 7,
    currentStepName: '',
    progress: 0,
    logs: []
  }
};

// 도면 데이터 로드 함수
function loadDrawingsData() {
  try {
    const drawingsPath = path.join(__dirname, 'data', 'drawings_data.json');
    if (fs.existsSync(drawingsPath)) {
      const data = JSON.parse(fs.readFileSync(drawingsPath, 'utf-8'));
      globalState.drawingsData = data;
      console.log(`[INFO] 도면 데이터 로드 완료: ${data.drawings?.length || 0}건`);
      return data;
    }
  } catch (e) {
    console.log('[WARN] 도면 데이터 로드 실패:', e.message);
  }
  return null;
}

// 도면 유사 사양가 산정 함수
function findSimilarDrawingPrice(materialNo, poHistory, drawingsData) {
  if (!drawingsData || !drawingsData.drawings) {
    return null;
  }
  
  // 자재번호에서 키 추출 (호선번호 5자리 제거: 2597A + PZAFCS + ...)
  const materialKey = materialNo.length > 5 ? materialNo.substring(5) : materialNo;
  const prefix = materialKey.substring(0, 6); // PZAFCS, PZAFQB 등
  
  // PZAF 패턴만 처리 (배관재)
  if (!prefix.startsWith('PZAF')) {
    return null;
  }
  
  // 1. 도면 데이터에서 유사 자재 찾기 (PZAFCS, PZAFQB 패턴)
  const similarDrawings = drawingsData.drawings.filter(d => {
    const stockNum = d.drawing_metadata?.stock_number || '';
    return stockNum.startsWith(prefix) || stockNum.includes(prefix.substring(2)); // PZAFCS 또는 AFCS
  });
  
  if (similarDrawings.length === 0) return null;
  
  // 2. PO 실적에서 유사 패턴 자재 찾기
  const similarPO = poHistory.filter(row => {
    const poMatNum = String(row['자재번호'] || '');
    return poMatNum.includes(prefix);
  });
  
  if (similarPO.length === 0) return null;
  
  // 3. kg당 평균 단가 계산
  let totalAmount = 0;
  let totalWeight = 0;
  const priceDetails = [];
  
  similarPO.forEach(po => {
    const amount = parseFloat(po['발주금액(KRW)-변환']) || 0;
    const weight = parseFloat(po['발주중량(KG)']) || 0;
    const qty = parseFloat(po['발주수량']) || 1;
    
    if (amount > 0 && weight > 0) {
      totalAmount += amount;
      totalWeight += weight;
      priceDetails.push({
        materialNo: po['자재번호'],
        amount: amount,
        weight: weight,
        qty: qty,
        unitPrice: Math.round(amount / qty),
        pricePerKg: Math.round(amount / weight)
      });
    }
  });
  
  if (totalWeight === 0) return null;
  
  const avgPricePerKg = totalAmount / totalWeight;
  
  // 4. 평균 단위중량 계산
  const avgUnitWeight = priceDetails.reduce((sum, p) => sum + (p.weight / p.qty), 0) / priceDetails.length;
  
  // 5. 도면 정보 추출
  const drawingInfo = similarDrawings.map(d => ({
    stockNumber: d.drawing_metadata?.stock_number,
    standardName: d.drawing_metadata?.standard_name,
    material: d.material_and_processing?.material,
    weightPerUnit: d.material_and_processing?.weight_per_unit,
    type: d.product_specification?.type
  }));
  
  return {
    avgPricePerKg: Math.round(avgPricePerKg),
    avgUnitWeight: Math.round(avgUnitWeight * 10) / 10,
    similarCount: similarPO.length,
    prefix: prefix,
    drawingInfo: drawingInfo,
    priceDetails: priceDetails.slice(0, 10), // 상위 10건만
    reasoning: `${prefix} 패턴 ${similarPO.length}건의 PO 실적 기반, 평균 kg당 단가 ${Math.round(avgPricePerKg).toLocaleString()}원/kg, 평균 단위중량 ${(Math.round(avgUnitWeight * 10) / 10)}kg/EA`
  };
}

// Configuration
const CONFIG = {
  SIMULATION_DATE: new Date('2026-01-01'),
  REQUIRED_COLUMNS: ['구매요청', '자재번호', '내역', '구매요청일', 'PR납기일', 'LEAD_TIME', '소싱그룹', '자재그룹'],
  URGENCY_URGENT: 2,
  URGENCY_NORMAL: 5,
  REASON_DESIGNATED: '지명경쟁_AC002_2. 계약의 성질 또는 목적에 비추어 특수한 설비/자재/물품 또는 실적이 있는 자가 아니면 계약의 목적을 달성하기 곤란한 경우로서 입찰대상자가 10인 이내인 경우',
  REASON_PRIVATE: '수의계약_SV023_2. 계약 목적의 특성 상 경쟁입찰에 부칠 수 없거나 경쟁입찰에 부칠 경우 현저하게 불리하다고 인정 되는 경우 및 경쟁입찰보다 수의계약을 체결하는 것이 계약목적 달성에 부합하는 것으로 판단되는 경우 등 수의계약에 의하는 것이 불가피하다고 인정될 때',
  LLM_MODEL: 'claude-sonnet-4-6'
};

// Helper functions
function parseExcelFile(buffer, filename) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet);
  return data;
}

function addLog(message, type = 'info') {
  const log = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  globalState.processingStatus.logs.push(log);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// Convert Excel Serial Number to JS Date
function excelSerialToDate(serial) {
  if (!serial) return null;
  
  // If it's already a Date object or valid date string
  if (serial instanceof Date) return serial;
  if (typeof serial === 'string') {
    const parsed = new Date(serial);
    if (!isNaN(parsed.getTime())) return parsed;
  }
  
  // Excel serial number (number of days since 1900-01-01)
  if (typeof serial === 'number' && serial > 25000 && serial < 100000) {
    const utcDays = Math.floor(serial - 25569);
    const utcValue = utcDays * 86400;
    return new Date(utcValue * 1000);
  }
  
  return null;
}

function calculateDaysDiff(date1, date2) {
  if (!date1 || !date2) return null;
  const d1 = excelSerialToDate(date1) || new Date(date1);
  const d2 = date2 instanceof Date ? date2 : new Date(date2);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
  return Math.ceil((d1 - d2) / (1000 * 60 * 60 * 24));
}

// LLM Helper
async function callLLM(prompt, system = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('No ANTHROPIC_API_KEY, skipping LLM call');
    return null;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CONFIG.LLM_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        ...(system && { system })
      })
    });

    if (!response.ok) {
      console.error('LLM API error:', response.status);
      return null;
    }

    const data = await response.json();
    return data.content?.[0]?.text || null;
  } catch (error) {
    console.error('LLM call error:', error);
    return null;
  }
}

function parseLLMJson(text) {
  if (!text) return {};

  // JSON 문자열을 파싱 시도 (실패 시 trailing comma 등 정리 후 재시도)
  const tryParse = (raw) => {
    if (!raw) return null;
    const candidate = raw.trim();
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // 흔한 오류 정리: 객체/배열 끝의 trailing comma 제거
      const cleaned = candidate.replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(cleaned);
      } catch (_) {
        return null;
      }
    }
  };

  // 1) ```json ... ``` 또는 ``` ... ``` 코드펜스 우선 처리
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    const parsed = tryParse(fence[1]);
    if (parsed) return parsed;
  }

  // 2) 첫 '{' 부터 중괄호 균형이 맞는 지점까지 추출 (greedy 매칭보다 안정적)
  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  // 3) 전체 텍스트 마지막 시도
  const parsed = tryParse(text);
  if (parsed) return parsed;

  console.error('JSON parse error: LLM 응답에서 유효한 JSON을 찾지 못했습니다.\n원본 응답:', text);
  return {};
}

// ============================================================
// LLM 기능 구현: HITL 검토, 최종 견적 분석, 이메일 생성
// ============================================================

/**
 * Step 7: HITL 검토 시 LLM 추천 의견 생성
 */
async function generateHITLRecommendation(prData) {
  const prompt = `당신은 조선/해양 산업의 구매 전문가입니다.

## HITL(Human-In-The-Loop) 검토 요청

다음 구매요청(PR)에 대해 검토가 필요합니다. 전문가 의견을 제시해주세요.

### PR 정보
- 구매요청번호: ${prData['구매요청']}
- 자재번호: ${prData['자재번호']}
- 자재내역: ${prData['내역']}
- 요청수량: ${prData['요청수량']} ${prData['UOM'] || 'EA'}
- 긴급도: ${prData['긴급도']} (${prData['긴급도_신호'] || ''})
- 계약방식: ${prData['계약방식']}

### 가격 정보
- 입찰예정가: ${(prData['입찰예정가'] || 0).toLocaleString()}원
- 견적금액: ${Math.round(prData['Mock_견적금액'] || 0).toLocaleString()}원
- 최근발주단가: ${(prData['최근발주단가'] || 0).toLocaleString()}원
- 단가변동률: ${(prData['단가변동률'] || 0).toFixed(1)}%
- 견적경쟁력: ${prData['견적경쟁력']} ${prData['견적경쟁력_신호'] || ''}

### 검토 사유
- ${prData['계약방식'] === '수의계약' ? `수의계약 적정성: ${prData['수의계약_적정성']}` : `최저가 적정성: ${prData['최저가_적정성']}`}

### 요청
이 PR에 대한 검토 의견과 추천 조치를 JSON 형식으로 제시해주세요.

\`\`\`json
{
  "추천결정": "승인" 또는 "반려" 또는 "협상요청",
  "검토의견": "상세한 검토 의견 (2-3문장)",
  "주요근거": ["근거1", "근거2"],
  "위험요소": "있다면 위험 요소 설명",
  "추가조치": "필요한 추가 조치 (없으면 null)"
}
\`\`\``;

  const response = await callLLM(prompt);
  const result = parseLLMJson(response);
  
  // 로그 기록
  globalState.llmLogs.push({
    type: 'HITL_REVIEW',
    timestamp: new Date().toISOString(),
    pr: prData['구매요청'],
    material: prData['자재번호'],
    result
  });
  
  return result;
}

/**
 * Step 8: 최종 견적 비교 LLM 분석
 */
async function generateQuotationAnalysis(quotationData) {
  // 주요 통계 계산
  const totalItems = quotationData.length;
  const totalAmount = quotationData.reduce((sum, r) => sum + (r['Mock_견적금액'] || 0), 0);
  const avgCompetitiveness = {
    excellent: quotationData.filter(r => r['견적경쟁력'] === '우수').length,
    normal: quotationData.filter(r => r['견적경쟁력'] === '보통').length,
    poor: quotationData.filter(r => r['견적경쟁력'] === '열위').length
  };
  const urgencyDist = {
    urgent: quotationData.filter(r => r['긴급도'] === '긴급').length,
    normal: quotationData.filter(r => r['긴급도'] === '일반').length,
    flexible: quotationData.filter(r => r['긴급도'] === '여유').length
  };
  
  // 상위 5건 고가 품목
  const topExpensive = [...quotationData]
    .sort((a, b) => (b['Mock_견적금액'] || 0) - (a['Mock_견적금액'] || 0))
    .slice(0, 5)
    .map(r => ({
      pr: r['구매요청'],
      material: r['내역']?.substring(0, 30),
      amount: Math.round(r['Mock_견적금액'] || 0)
    }));
  
  // 검토 필요 항목
  const needReview = quotationData.filter(r => r['HITL필요']).length;
  
  const prompt = `당신은 조선/해양 산업의 구매 분석 전문가입니다.

## 견적 비교 분석 요청

이번 견적 라운드의 전체 결과를 분석해주세요.

### 전체 현황
- 총 견적 건수: ${totalItems}건
- 총 견적 금액: ${Math.round(totalAmount).toLocaleString()}원

### 견적 경쟁력 분포
- 우수 (예정가 이하): ${avgCompetitiveness.excellent}건
- 보통: ${avgCompetitiveness.normal}건
- 열위 (예정가 초과): ${avgCompetitiveness.poor}건

### 긴급도 분포
- 긴급: ${urgencyDist.urgent}건
- 일반: ${urgencyDist.normal}건
- 여유: ${urgencyDist.flexible}건

### 검토 필요 항목
- HITL 검토 필요: ${needReview}건

### 상위 5건 고가 품목
${topExpensive.map((item, i) => `${i+1}. ${item.pr}: ${item.material}... - ${item.amount.toLocaleString()}원`).join('\n')}

### 요청
이 견적 결과에 대한 종합 분석을 JSON 형식으로 제시해주세요.

\`\`\`json
{
  "종합평가": "전체적인 평가 (1-2문장)",
  "경쟁력분석": "견적 경쟁력에 대한 분석",
  "위험항목": ["주의가 필요한 항목들"],
  "비용절감기회": "비용 절감 가능한 부분"
}
\`\`\``;

  const response = await callLLM(prompt);
  const result = parseLLMJson(response);
  
  // 로그 기록
  globalState.llmLogs.push({
    type: 'QUOTATION_ANALYSIS',
    timestamp: new Date().toISOString(),
    totalItems,
    totalAmount: Math.round(totalAmount),
    result
  });
  
  return {
    statistics: {
      totalItems,
      totalAmount: Math.round(totalAmount),
      competitiveness: avgCompetitiveness,
      urgency: urgencyDist,
      needReview,
      topExpensive
    },
    analysis: result
  };
}

/**
 * Step 2: 누락 PR 알림 이메일 내용 LLM 생성
 */
async function generateMissingPREmail(invalidPRList, recipientInfo = {}) {
  // 누락 항목 요약
  const missingCategories = {};
  invalidPRList.forEach(pr => {
    const missing = pr['누락항목'] || '기타';
    missing.split(', ').forEach(item => {
      missingCategories[item] = (missingCategories[item] || 0) + 1;
    });
  });
  
  // 소싱그룹별 분류
  const bySourcingGroup = {};
  invalidPRList.forEach(pr => {
    const group = pr['소싱그룹명'] || pr['소싱그룹'] || '미분류';
    if (!bySourcingGroup[group]) bySourcingGroup[group] = [];
    bySourcingGroup[group].push(pr);
  });
  
  const prompt = `당신은 조선/해양 산업의 구매 관리자입니다.

## 누락 PR 알림 이메일 작성 요청

다음 정보를 바탕으로 PR 데이터 누락에 대한 알림 이메일을 작성해주세요.

### 누락 현황
- 총 누락 건수: ${invalidPRList.length}건
- 누락 항목별 분포:
${Object.entries(missingCategories).map(([item, count]) => `  - ${item}: ${count}건`).join('\n')}

### 소싱그룹별 분포
${Object.entries(bySourcingGroup).slice(0, 5).map(([group, items]) => `  - ${group}: ${items.length}건`).join('\n')}

### 샘플 누락 PR (상위 5건)
${invalidPRList.slice(0, 5).map(pr => `- PR ${pr['구매요청']}: ${pr['자재번호']} / 누락: ${pr['누락항목']}`).join('\n')}

### 요청
공식적이고 전문적인 이메일을 작성해주세요. 다음 형식으로 응답해주세요.

\`\`\`json
{
  "제목": "이메일 제목",
  "본문": "이메일 본문 (HTML 형식, 줄바꿈은 <br>로)",
  "중요도": "높음" 또는 "보통",
  "조치기한": "권장 조치 기한",
  "담당부서": ["관련 담당 부서 목록"]
}
\`\`\``;

  const response = await callLLM(prompt);
  const result = parseLLMJson(response);
  
  // 로그 기록
  globalState.llmLogs.push({
    type: 'EMAIL_GENERATION',
    timestamp: new Date().toISOString(),
    invalidCount: invalidPRList.length,
    categories: missingCategories,
    result
  });
  
  // 이메일 로그에도 추가
  if (result.제목) {
    globalState.emailLogs.push({
      type: 'MISSING_PR_ALERT',
      timestamp: new Date().toISOString(),
      subject: result.제목,
      invalidCount: invalidPRList.length,
      status: 'generated'
    });
  }
  
  return result;
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    hasApiKey: !!process.env.ANTHROPIC_API_KEY
  });
});

// Upload files
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const results = [];
    globalState.prData = [];
    globalState.poHistory = [];

    for (const file of files) {
      const data = parseExcelFile(file.buffer, file.originalname);
      const fname = file.originalname;
      console.log(`Processing file: ${fname}, rows: ${data.length}`);
      
      // PZAF 발주실적 파일 (PZAF와 발주실적 또는 발주 포함)
      if (fname.includes('PZAF')) {
        globalState.poHistory = data;
        results.push({
          filename: fname,
          type: 'po_history',
          rows: data.length
        });
        console.log(`  -> Loaded as PO History: ${data.length} rows`);
      } 
      // PR 데이터 파일 (구매요청 포함 또는 1P0 포함)
      else if (fname.includes('구매요청') || fname.includes('1P0K') || fname.includes('1P0M')) {
        // Add source identifier
        const source = fname.includes('1P0K02') ? '1P0K02' : 
                      fname.includes('1P0M01') ? '1P0M01' : 'Unknown';
        data.forEach(row => row['데이터소스'] = source);
        globalState.prData = globalState.prData.concat(data);
        results.push({
          filename: fname,
          type: 'pr_data',
          source,
          rows: data.length
        });
        console.log(`  -> Loaded as PR Data (${source}): ${data.length} rows`);
      }
      // 기타 엑셀 파일도 PR로 시도
      else if (fname.toLowerCase().endsWith('.xlsx') || fname.toLowerCase().endsWith('.xls')) {
        // Check if it has PR-like columns
        if (data.length > 0 && data[0]['구매요청']) {
          const source = 'Generic';
          data.forEach(row => row['데이터소스'] = source);
          globalState.prData = globalState.prData.concat(data);
          results.push({
            filename: fname,
            type: 'pr_data',
            source,
            rows: data.length
          });
          console.log(`  -> Loaded as Generic PR Data: ${data.length} rows`);
        } else {
          console.log(`  -> Skipped (unknown format)`);
        }
      }
    }

    res.json({
      success: true,
      files: results,
      summary: {
        totalPR: globalState.prData.length,
        totalPO: globalState.poHistory.length
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Load sample data from server (pre-uploaded files)
app.post('/api/load-sample', async (req, res) => {
  try {
    const samplePath = path.join(__dirname, 'data');
    
    // Check if sample data directory exists
    if (!fs.existsSync(samplePath)) {
      return res.status(404).json({ error: 'Sample data not found. Please upload files manually.' });
    }

    const files = fs.readdirSync(samplePath).filter(f => 
      f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.xls')
    );

    if (files.length === 0) {
      return res.status(404).json({ error: 'No Excel files found in sample data.' });
    }

    const results = [];
    globalState.prData = [];
    globalState.poHistory = [];

    for (const filename of files) {
      const filePath = path.join(samplePath, filename);
      const buffer = fs.readFileSync(filePath);
      const data = parseExcelFile(buffer, filename);
      
      console.log(`Loading sample file: ${filename}, rows: ${data.length}`);

      if (filename.includes('PZAF')) {
        globalState.poHistory = data;
        results.push({
          filename: filename,
          type: 'po_history',
          rows: data.length
        });
      } else if (filename.includes('1P0K') || filename.includes('1P0M') || filename.includes('구매요청')) {
        const source = filename.includes('1P0K02') ? '1P0K02' : 
                      filename.includes('1P0M01') ? '1P0M01' : 'Unknown';
        data.forEach(row => row['데이터소스'] = source);
        globalState.prData = globalState.prData.concat(data);
        results.push({
          filename: filename,
          type: 'pr_data',
          source,
          rows: data.length
        });
      }
    }

    res.json({
      success: true,
      files: results,
      summary: {
        totalPR: globalState.prData.length,
        totalPO: globalState.poHistory.length
      }
    });
  } catch (error) {
    console.error('Load sample error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get processing status
app.get('/api/status', (req, res) => {
  res.json(globalState.processingStatus);
});

// Get current data summary
app.get('/api/summary', (req, res) => {
  const prData = globalState.prData;
  const poHistory = globalState.poHistory;
  
  // PZAF count
  const pzafCount = prData.filter(row => 
    String(row['자재번호'] || '').includes('PZAF')
  ).length;

  res.json({
    prTotal: prData.length,
    poHistoryTotal: poHistory.length,
    pzafCount,
    hasData: prData.length > 0
  });
});

// Process PR data (Main Agent Logic)
app.post('/api/process', async (req, res) => {
  try {
    if (globalState.prData.length === 0) {
      return res.status(400).json({ error: 'No PR data loaded. Please upload files first.' });
    }

    // Reset state
    globalState.processingStatus = {
      step: 0,
      totalSteps: 7,
      currentStepName: '초기화',
      progress: 0,
      logs: []
    };
    globalState.llmLogs = [];
    globalState.emailLogs = [];

    const results = await processAgent();
    globalState.processingResults = results;

    res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get processing results
app.get('/api/results', (req, res) => {
  if (!globalState.processingResults) {
    return res.status(404).json({ error: 'No results available. Run processing first.' });
  }
  res.json(globalState.processingResults);
});

// Get price estimation reasoning (도면 유사 사양가 근거)
app.get('/api/price-reasoning/:prId', (req, res) => {
  const { prId } = req.params;
  
  if (!globalState.processingResults?.quotationData) {
    return res.status(404).json({ error: 'No quotation data' });
  }
  
  const pr = globalState.processingResults.quotationData.find(
    q => String(q['구매요청']) === String(prId)
  );
  
  if (!pr) {
    return res.status(404).json({ error: 'PR not found' });
  }
  
  const reasoning = {
    prId: prId,
    materialNo: pr['자재번호'],
    description: pr['내역'],
    method: pr['예정가_산정방법'],
    estimatedPrice: pr['입찰예정가'],
    recentOrderPrice: pr['최근발주단가'],
    quantity: pr['요청수량'],
    unitWeight: pr['단중(kg)'],
    materialGroup: pr['자재그룹']
  };
  
  // 산정방법별 상세 근거
  if (pr['예정가_산정방법'] === '자재+내역 일치') {
    reasoning.detail = {
      type: 'exact_match',
      description: '동일 자재번호+내역의 과거 PO 발주실적 기반',
      formula: '입찰예정가 = 과거 발주단가 × 요청수량'
    };
  } else if (pr['예정가_산정방법'] === '도면 유사 사양가') {
    reasoning.detail = {
      type: 'similar_drawing',
      description: '유사 도면 패턴 기반 예상가 산정',
      similarInfo: pr['유사사양_근거'] || {},
      formula: '입찰예정가 = 유사자재 평균 kg당 단가 × 추정 중량 × 요청수량'
    };
  } else if (pr['예정가_산정방법'] === '자재별 그룹 단가 평균') {
    reasoning.detail = {
      type: 'group_average',
      description: '자재그룹별 중량 기준 평균단가 적용',
      avgPricePerKg: pr['그룹평균단가_원KG'],
      group: pr['산정그룹'],
      formula: '입찰예정가 = 그룹 평균단가(원/kg) × 단중(kg) × 요청수량'
    };
  } else {
    reasoning.detail = {
      type: 'default',
      description: '과거 실적 없음, 기본값 적용',
      defaultPrice: 1000000
    };
  }
  
  res.json(reasoning);
});

// Get quotation list
app.get('/api/quotations', (req, res) => {
  if (!globalState.processingResults) {
    return res.status(404).json({ error: 'No results available' });
  }
  res.json(globalState.processingResults.quotationData || []);
});

// Update quotation
app.put('/api/quotations/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  if (!globalState.processingResults?.quotationData) {
    return res.status(404).json({ error: 'No quotation data' });
  }

  const index = globalState.processingResults.quotationData.findIndex(
    q => q['구매요청'] === id
  );

  if (index === -1) {
    return res.status(404).json({ error: 'Quotation not found' });
  }

  globalState.processingResults.quotationData[index] = {
    ...globalState.processingResults.quotationData[index],
    ...updates,
    수정일시: new Date().toISOString(),
    수정여부: true
  };

  res.json({ success: true, data: globalState.processingResults.quotationData[index] });
});

// Approve quotation
app.post('/api/quotations/:id/approve', (req, res) => {
  const { id } = req.params;
  
  if (!globalState.processingResults?.quotationData) {
    return res.status(404).json({ error: 'No quotation data' });
  }

  const index = globalState.processingResults.quotationData.findIndex(
    q => q['구매요청'] === id
  );

  if (index === -1) {
    return res.status(404).json({ error: 'Quotation not found' });
  }

  globalState.processingResults.quotationData[index].승인상태 = '승인완료';
  globalState.processingResults.quotationData[index].승인일시 = new Date().toISOString();

  res.json({ success: true });
});

// Batch approve
app.post('/api/quotations/batch-approve', (req, res) => {
  const { ids } = req.body;
  
  if (!globalState.processingResults?.quotationData) {
    return res.status(404).json({ error: 'No quotation data' });
  }

  let approved = 0;
  ids.forEach(id => {
    const index = globalState.processingResults.quotationData.findIndex(
      q => q['구매요청'] === id
    );
    if (index !== -1) {
      globalState.processingResults.quotationData[index].승인상태 = '승인완료';
      globalState.processingResults.quotationData[index].승인일시 = new Date().toISOString();
      approved++;
    }
  });

  res.json({ success: true, approved });
});

// Export to Excel
app.get('/api/export', (req, res) => {
  if (!globalState.processingResults) {
    return res.status(404).json({ error: 'No results to export' });
  }

  const wb = XLSX.utils.book_new();
  
  // Main results sheet
  if (globalState.processingResults.quotationData?.length) {
    const ws = XLSX.utils.json_to_sheet(globalState.processingResults.quotationData);
    XLSX.utils.book_append_sheet(wb, ws, '검토결과');
  }

  // Summary sheet
  const summary = globalState.processingResults.summary || {};
  const summaryData = [
    ['PR→PO Agent 처리 결과', ''],
    ['', ''],
    ['총 처리 건수', summary.total || 0],
    ['긴급', summary.urgent || 0],
    ['일반', summary.normal || 0],
    ['여유', summary.flexible || 0],
    ['', ''],
    ['자동완료', summary.autoComplete || 0],
    ['검토필요', summary.needReview || 0]
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, ws2, '요약');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=PR_PO_Agent_Result.xlsx');
  res.send(buffer);
});

// Get email logs
app.get('/api/emails', (req, res) => {
  res.json(globalState.emailLogs);
});

// Get LLM logs
app.get('/api/llm-logs', (req, res) => {
  res.json(globalState.llmLogs);
});

// =============================================================================
// LLM API Endpoints
// =============================================================================

/**
 * HITL 검토 - LLM 추천 의견 요청
 * POST /api/llm/hitl-review
 */
app.post('/api/llm/hitl-review', async (req, res) => {
  try {
    const { prId } = req.body;
    
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ 
        error: 'LLM API key not configured',
        fallback: {
          추천결정: '검토필요',
          검토의견: 'LLM API 키가 설정되지 않아 자동 추천이 불가합니다. 담당자가 직접 검토해주세요.',
          주요근거: ['API 키 미설정'],
          위험요소: null,
          추가조치: '담당자 수동 검토 필요'
        }
      });
    }
    
    if (!globalState.processingResults?.quotationData) {
      return res.status(404).json({ error: 'No quotation data available' });
    }
    
    const prData = globalState.processingResults.quotationData.find(
      q => String(q['구매요청']) === String(prId)
    );
    
    if (!prData) {
      return res.status(404).json({ error: 'PR not found' });
    }
    
    const result = await generateHITLRecommendation(prData);
    
    // 결과를 PR 데이터에도 저장
    const index = globalState.processingResults.quotationData.findIndex(
      q => String(q['구매요청']) === String(prId)
    );
    if (index !== -1) {
      globalState.processingResults.quotationData[index]['LLM추천'] = result;
    }
    
    res.json({
      success: true,
      prId,
      recommendation: result
    });
  } catch (error) {
    console.error('HITL review error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 최종 견적 비교 분석 - LLM 분석 요청
 * POST /api/llm/quotation-analysis
 */
app.post('/api/llm/quotation-analysis', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ 
        error: 'LLM API key not configured',
        fallback: {
          statistics: {
            totalItems: globalState.processingResults?.quotationData?.length || 0,
            totalAmount: 0,
            competitiveness: { excellent: 0, normal: 0, poor: 0 },
            urgency: { urgent: 0, normal: 0, flexible: 0 },
            needReview: 0,
            topExpensive: []
          },
          analysis: {
            종합평가: 'LLM API 키가 설정되지 않아 자동 분석이 불가합니다.',
            경쟁력분석: '수동 분석이 필요합니다.',
            위험항목: ['API 키 미설정'],
            비용절감기회: '분석 불가'
          }
        }
      });
    }
    
    if (!globalState.processingResults?.quotationData) {
      return res.status(404).json({ error: 'No quotation data available' });
    }
    
    const result = await generateQuotationAnalysis(globalState.processingResults.quotationData);
    
    // 분석 결과 저장
    globalState.processingResults.quotationAnalysis = result;
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Quotation analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 누락 PR 알림 이메일 생성 - LLM 이메일 작성
 * POST /api/llm/generate-email
 */
app.post('/api/llm/generate-email', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      const invalidCount = globalState.processingResults?.invalidPR?.length || 0;
      return res.status(400).json({ 
        error: 'LLM API key not configured',
        fallback: {
          제목: `[PR 데이터 누락 알림] ${invalidCount}건 확인 필요`,
          본문: `<p>안녕하세요,</p>
<p>PR 데이터 검증 결과 <strong>${invalidCount}건</strong>의 누락 항목이 발견되었습니다.</p>
<p>해당 PR의 필수 정보를 보완하여 주시기 바랍니다.</p>
<br>
<p>감사합니다.</p>`,
          중요도: '높음',
          조치기한: '3영업일 이내',
          담당부서: ['구매팀', '자재팀']
        }
      });
    }
    
    if (!globalState.processingResults?.invalidPR) {
      return res.status(404).json({ error: 'No invalid PR data available' });
    }
    
    const result = await generateMissingPREmail(globalState.processingResults.invalidPR);
    
    res.json({
      success: true,
      email: result
    });
  } catch (error) {
    console.error('Email generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * LLM 상태 확인
 * GET /api/llm/status
 */
app.get('/api/llm/status', (req, res) => {
  res.json({
    enabled: !!process.env.ANTHROPIC_API_KEY,
    model: CONFIG.LLM_MODEL,
    logsCount: globalState.llmLogs.length,
    features: {
      hitlReview: true,
      quotationAnalysis: true,
      emailGeneration: true
    }
  });
});

// =============================================================================
// Main Agent Processing Logic
// =============================================================================

async function processAgent() {
  const startTime = Date.now();
  let workingData = [...globalState.prData];
  const poHistory = [...globalState.poHistory];
  let allPRData = [];  // 전체 PR 데이터 보관용 (Step 1~3용)
  
  // Create material key (remove ship number prefix)
  workingData.forEach(row => {
    const matNo = String(row['자재번호'] || '');
    row['자재번호_키'] = matNo.length > 4 ? matNo.substring(4) : matNo;
    row['PZAF여부'] = matNo.includes('PZAF');
  });

  poHistory.forEach(row => {
    const matNo = String(row['자재번호'] || '');
    row['자재번호_키'] = matNo.length > 4 ? matNo.substring(4) : matNo;
  });

  // Step 1: Data Validation
  updateStatus(1, '데이터 검증');
  addLog('PR 데이터 검증 시작...');
  
  const validData = [];
  const invalidData = [];
  
  workingData.forEach(row => {
    let missing = [];
    CONFIG.REQUIRED_COLUMNS.forEach(col => {
      if (!row[col] || String(row[col]).trim() === '') {
        missing.push(col);
      }
    });
    
    if (missing.length > 0) {
      row['누락항목'] = missing.join(', ');
      row['검증결과'] = 'FAIL';
      invalidData.push(row);
    } else {
      row['검증결과'] = 'PASS';
      validData.push(row);
    }
  });
  
  addLog(`유효 PR: ${validData.length}건, 누락 PR: ${invalidData.length}건`);

  // Step 2: Email notification for invalid PRs
  updateStatus(2, '누락 PR 이메일 발송 준비');
  
  if (invalidData.length > 0) {
    const grouped = {};
    invalidData.forEach(row => {
      const requester = row['구매요청자'] || '담당자미지정';
      if (!grouped[requester]) grouped[requester] = [];
      grouped[requester].push(row);
    });
    
    Object.entries(grouped).forEach(([requester, rows]) => {
      globalState.emailLogs.push({
        timestamp: new Date().toISOString(),
        recipient: requester,
        email: `${requester}@company.com`,
        subject: `[PR 필수항목 누락] ${rows.length}건 정보 업데이트 요청`,
        prCount: rows.length,
        prList: rows.map(r => ({
          pr: r['구매요청'],
          material: r['자재번호'],
          missing: r['누락항목']
        })),
        status: '발송예정'
      });
    });
    addLog(`이메일 발송 예정: ${Object.keys(grouped).length}명, ${invalidData.length}건`);
  }

  workingData = validData;
  allPRData = [...validData];  // 전체 유효 PR 데이터 저장 (PZAF 필터링 전)

  // Step 3: Contract Classification
  updateStatus(3, '계약 분류');
  addLog('계약 분류 시작...');
  
  workingData.forEach(row => {
    const hasContract = row['단가계약번호'] && String(row['단가계약번호']).trim() !== '';
    const hasAutoAlloc = row['자동배량그룹'] && String(row['자동배량그룹']).trim() !== '';
    
    if (hasContract && hasAutoAlloc) {
      row['계약분류'] = '표준단가';
    } else if (hasContract && !hasAutoAlloc) {
      row['계약분류'] = '비표준단가';
    } else {
      row['계약분류'] = 'NA';
    }
  });
  
  const contractSummary = {
    standard: workingData.filter(r => r['계약분류'] === '표준단가').length,
    nonStandard: workingData.filter(r => r['계약분류'] === '비표준단가').length,
    na: workingData.filter(r => r['계약분류'] === 'NA').length
  };
  addLog(`표준단가: ${contractSummary.standard}건, 비표준단가: ${contractSummary.nonStandard}건, NA(견적): ${contractSummary.na}건`);

  // Step 4: Urgency Calculation
  updateStatus(4, '긴급도 산정');
  addLog('긴급도 분석 중...');
  
  workingData.forEach(row => {
    const prDeadline = row['PR납기일'];
    const leadTime = parseInt(row['LEAD_TIME']) || 0;
    
    if (prDeadline) {
      // Convert Excel serial to readable date for display
      const deadlineDate = excelSerialToDate(prDeadline);
      if (deadlineDate) {
        row['PR납기일_변환'] = deadlineDate.toISOString().split('T')[0];
      }
      
      const daysUntilDeadline = calculateDaysDiff(prDeadline, CONFIG.SIMULATION_DATE);
      row['납기까지일수'] = daysUntilDeadline;
      
      // 실제잔여일수 = 납기까지일수 - LEAD_TIME
      // (발주부터 납품까지 걸리는 시간을 고려한 실제 작업 가능 일수)
      row['실제잔여일수'] = daysUntilDeadline !== null ? daysUntilDeadline - leadTime : null;
      
      // 긴급도 판단 (실제잔여일수 기준)
      const remainDays = row['실제잔여일수'];
      if (remainDays === null) {
        row['긴급도'] = '일반';
        row['긴급도_신호'] = '🟡';
      } else if (remainDays <= CONFIG.URGENCY_URGENT) {
        // 2일 이하: 긴급 (이미 납기가 지났거나 매우 촉박)
        row['긴급도'] = '긴급';
        row['긴급도_신호'] = '🔴';
      } else if (remainDays <= CONFIG.URGENCY_NORMAL) {
        // 3~5일: 일반
        row['긴급도'] = '일반';
        row['긴급도_신호'] = '🟡';
      } else {
        // 5일 초과: 여유
        row['긴급도'] = '여유';
        row['긴급도_신호'] = '🟢';
      }
    } else {
      row['긴급도'] = '일반';
      row['긴급도_신호'] = '🟡';
      row['납기까지일수'] = null;
      row['실제잔여일수'] = null;
    }
  });
  
  const urgencySummary = {
    urgent: workingData.filter(r => r['긴급도'] === '긴급').length,
    normal: workingData.filter(r => r['긴급도'] === '일반').length,
    flexible: workingData.filter(r => r['긴급도'] === '여유').length
  };
  addLog(`🔴 긴급: ${urgencySummary.urgent}건, 🟡 일반: ${urgencySummary.normal}건, 🟢 여유: ${urgencySummary.flexible}건`);

  // Step 5: Supplier Matching
  updateStatus(5, '업체 매칭');
  addLog('납품업체 매칭 중...');
  
  // Create PO history lookup
  const poLookup = {};
  poHistory.forEach(row => {
    const key = row['자재번호_키'];
    const desc = String(row['자재내역'] || '').trim().toUpperCase();
    const lookupKey = `${key}_${desc}`;
    if (!poLookup[lookupKey]) {
      poLookup[lookupKey] = row;
    }
  });

  let matchedCount = 0;
  workingData.forEach(row => {
    const key = row['자재번호_키'];
    const desc = String(row['내역'] || '').trim().toUpperCase();
    const lookupKey = `${key}_${desc}`;
    
    const match = poLookup[lookupKey];
    if (match) {
      row['매칭업체코드'] = match['업체코드'];
      row['매칭업체명'] = match['업체명'];
      row['매칭발주수량'] = match['발주수량'];
      row['매칭발주금액'] = match['발주금액(KRW)-변환'];
      row['매칭_발주중량'] = match['발주중량'] || match['중량'] || match['총중량'] || match['발주수량'];
      row['업체매칭여부'] = true;
      matchedCount++;
    } else {
      row['업체매칭여부'] = false;
    }
  });
  
  addLog(`업체 매칭 완료: ${matchedCount}건 / ${workingData.length}건`);

  // Filter PZAF for quotation processing
  const pzafData = workingData.filter(row => row['PZAF여부']);
  addLog(`PZAF 자재 필터링: ${pzafData.length}건`);

  // Step 6: Quotation Processing
  updateStatus(6, '견적의뢰 생성 및 예정가 산정');
  
  // Determine order method
  pzafData.forEach(row => {
    row['발주방식'] = row['계약분류'] === '표준단가' ? '배량 후 발주' : '입찰(견적) 진행';
  });

  const quotationData = pzafData.filter(row => row['발주방식'] === '입찰(견적) 진행');
  addLog(`견적 진행 대상: ${quotationData.length}건`);

  // Check if material has PO history (for private contract)
  const poMaterialKeys = new Set(poHistory.map(r => r['자재번호_키']));
  
  quotationData.forEach(row => {
    row['수의계약대상'] = poMaterialKeys.has(row['자재번호_키']);
    
    // Contract method
    if (row['계약분류'] === '비표준단가') {
      row['계약방식'] = '비표준단가계약';
    } else if (row['수의계약대상']) {
      row['계약방식'] = '수의계약';
    } else {
      row['계약방식'] = '지명경쟁';
    }

    // Auto fill fields
    const prType = row['PR생성형태'];
    row['접수기간_일'] = (prType === '초긴급' || prType === '긴급') ? 1 : 3;
    row['계약방식_선정사유'] = row['계약방식'] === '지명경쟁' ? CONFIG.REASON_DESIGNATED :
                             row['계약방식'] === '수의계약' ? CONFIG.REASON_PRIVATE : '';
    row['미승인사유코드'] = '002_2';
    row['미승인사유'] = 'BULK 재료로서 생산 BOM에 의거 구매요청 발행';
    
    // Tech evaluation
    const vendorCode = String(row['매칭업체코드'] || '');
    row['기술평가대상'] = vendorCode.startsWith('2') ? 'Y' : 'N';
  });

  // Price estimation - 3단계 우선순위 적용
  // 1순위: 자재+내역 일치 (정확한 매칭)
  // 2순위: 도면 유사 사양가 (자재번호 패턴 기반 유사 도면 매칭)
  // 3순위: 자재별 그룹 단가 평균 (자재 그룹별 중량 기준 평균단가)
  addLog('입찰 예정가 산정 중...');
  
  // 도면 데이터 로드
  if (!globalState.drawingsData) {
    loadDrawingsData();
  }
  addLog(`도면 데이터 상태: ${globalState.drawingsData ? globalState.drawingsData.drawings?.length + '건' : '미로드'}`);
  
  // 자재그룹별 중량 기준 평균단가 계산
  // 그룹키: '자재그룹' 필드 (ex: 1P0M01, 1P0K02)
  // 공식: 자재그룹 평균단가(원/KG) = SUM(발주금액) / SUM(발주중량)
  const groupPriceByWeight = {};
  poHistory.forEach(row => {
    const groupKey = row['자재그룹'] || ''; // 자재그룹 필드 사용
    if (!groupKey) return;
    
    const amount = parseFloat(row['발주금액(KRW)-변환']) || 0;
    const weight = parseFloat(row['발주중량(KG)']) || 0;
    
    if (!groupPriceByWeight[groupKey]) {
      groupPriceByWeight[groupKey] = { totalAmount: 0, totalWeight: 0, count: 0 };
    }
    groupPriceByWeight[groupKey].totalAmount += amount;
    groupPriceByWeight[groupKey].totalWeight += weight;
    groupPriceByWeight[groupKey].count++;
  });
  
  // 자재그룹별 평균단가(원/KG) 계산
  const groupAvgPricePerKg = {};
  Object.entries(groupPriceByWeight).forEach(([groupKey, data]) => {
    if (data.totalWeight > 0) {
      groupAvgPricePerKg[groupKey] = data.totalAmount / data.totalWeight; // 원/KG
    }
  });
  
  addLog(`자재그룹 평균단가 산출: ${Object.keys(groupAvgPricePerKg).length}개 그룹`);

  for (const row of quotationData) {
    const key = row['자재번호_키'];
    const desc = String(row['내역'] || '').trim().toUpperCase();
    const qty = parseFloat(row['요청수량']) || 1;
    const unitWeight = parseFloat(row['단중(kg)']) || 0; // PR의 단중(kg) 필드
    const materialGroup = row['자재그룹'] || ''; // PR의 자재그룹 필드
    
    // Find matching price
    const matchKey = `${key}_${desc}`;
    const exactMatch = poLookup[matchKey];
    
    // 1순위: 자재+내역 일치
    if (exactMatch) {
      const matchQty = parseFloat(exactMatch['발주수량']) || 1;
      const matchAmount = parseFloat(exactMatch['발주금액(KRW)-변환']) || 0;
      const unitPrice = matchAmount / matchQty;
      row['입찰예정가'] = Math.round(unitPrice * qty);
      row['예정가_산정방법'] = '자재+내역 일치';
      row['최근발주단가'] = Math.round(unitPrice * qty); // 총액 기준 (단가 × 요청수량)
    }
    // 2순위: 도면 유사 사양가
    else {
      const similarResult = findSimilarDrawingPrice(row['자재번호'], poHistory, globalState.drawingsData);
      
      // 도면 유사 사양가 적용 조건: 유사 도면이 있고 PO 실적이 1건 이상
      if (similarResult && similarResult.similarCount >= 1) {
        // 도면 유사 사양가 적용
        const estimatedWeight = unitWeight > 0 ? unitWeight : similarResult.avgUnitWeight;
        const estimatedPrice = similarResult.avgPricePerKg * estimatedWeight * qty;
        
        row['입찰예정가'] = Math.ceil(estimatedPrice);
        row['예정가_산정방법'] = '도면 유사 사양가';
        row['최근발주단가'] = Math.ceil(estimatedPrice);
        row['유사사양_근거'] = {
          prefix: similarResult.prefix,
          avgPricePerKg: similarResult.avgPricePerKg,
          avgUnitWeight: similarResult.avgUnitWeight,
          estimatedWeight: estimatedWeight,
          similarCount: similarResult.similarCount,
          reasoning: similarResult.reasoning,
          drawingInfo: similarResult.drawingInfo,
          priceDetails: similarResult.priceDetails
        };
        row['산정그룹'] = similarResult.prefix;
      }
      // 3순위: 자재별 그룹 단가 평균 (자재그룹별 중량 기준)
      else if (groupAvgPricePerKg[materialGroup] && unitWeight > 0) {
        const avgPricePerKg = groupAvgPricePerKg[materialGroup];
        const estimatedPrice = avgPricePerKg * qty * unitWeight;
        row['입찰예정가'] = Math.ceil(estimatedPrice);
        row['예정가_산정방법'] = '자재별 그룹 단가 평균';
        row['최근발주단가'] = Math.ceil(estimatedPrice);
        row['그룹평균단가_원KG'] = avgPricePerKg;
        row['산정그룹'] = materialGroup;
      }
      // 자재별 그룹 단가 평균 - 단중이 없는 경우
      else if (groupAvgPricePerKg[materialGroup]) {
        const avgPricePerKg = groupAvgPricePerKg[materialGroup];
        const estimatedPrice = Math.ceil(avgPricePerKg * qty);
        row['입찰예정가'] = estimatedPrice;
        row['예정가_산정방법'] = '자재별 그룹 단가 평균';
        row['최근발주단가'] = estimatedPrice;
        row['그룹평균단가_원KG'] = avgPricePerKg;
        row['산정그룹'] = materialGroup;
      }
      // 기본값: 해당 자재그룹의 PO 실적 없음
      else {
        row['입찰예정가'] = 1000000;
        row['예정가_산정방법'] = '기본값';
        row['최근발주단가'] = 0;
        row['산정그룹'] = materialGroup || 'N/A';
      }
    }
  }

  const priceMethods = {};
  quotationData.forEach(row => {
    const method = row['예정가_산정방법'] || '기타';
    priceMethods[method] = (priceMethods[method] || 0) + 1;
  });
  Object.entries(priceMethods).forEach(([method, count]) => {
    addLog(`예정가 산정 - ${method}: ${count}건`);
  });

  // Step 7: Appropriateness Review
  updateStatus(7, '적정성 검토');
  addLog('적정성 검토 중...');

  // Mock quotation prices for simulation
  quotationData.forEach(row => {
    const estimated = row['입찰예정가'] || 1000000;
    row['Mock_견적금액'] = estimated * (0.8 + Math.random() * 0.4);
    row['견적단가'] = row['Mock_견적금액'] / (parseFloat(row['요청수량']) || 1);
    row['예정단가'] = row['입찰예정가'] / (parseFloat(row['요청수량']) || 1);
    
    // Competitiveness evaluation
    const qPrice = row['견적단가'];
    const ePrice = row['예정단가'];
    const rPrice = row['최근발주단가'] || ePrice;
    
    if (qPrice <= ePrice) {
      row['견적경쟁력'] = '우수';
      row['견적경쟁력_신호'] = '🟢';
    } else if (qPrice <= rPrice) {
      row['견적경쟁력'] = '보통';
      row['견적경쟁력_신호'] = '🟡';
    } else {
      row['견적경쟁력'] = '열위';
      row['견적경쟁력_신호'] = '🔴';
    }
  });

  // Appropriateness check
  quotationData.forEach(row => {
    const comp = row['견적경쟁력'];
    const qPrice = row['견적단가'];
    const ePrice = row['예정단가'];
    
    // Dumping check: below 70% of estimated price
    const dumpingThreshold = ePrice * 0.7;
    
    if (row['계약방식'] === '수의계약') {
      // Private contract check
      const recentPrice = row['최근발주단가'] || ePrice;
      const changeRate = recentPrice > 0 ? ((qPrice / recentPrice) - 1) * 100 : 0;
      row['단가변동률'] = changeRate;
      
      if (changeRate <= 15) {
        row['수의계약_적정성'] = '적정';
        row['HITL필요'] = false;
        row['처리상태'] = '자동완료';
      } else {
        row['수의계약_적정성'] = '협상필요';
        row['HITL필요'] = true;
        row['처리상태'] = '검토필요';
      }
    } else {
      // Competitive bidding check
      if (comp === '우수' && qPrice < dumpingThreshold) {
        row['최저가_적정성'] = '덤핑의심';
        row['HITL필요'] = true;
        row['처리상태'] = '검토필요';
      } else if (comp === '열위') {
        row['최저가_적정성'] = '검토필요';
        row['HITL필요'] = true;
        row['처리상태'] = '검토필요';
      } else {
        row['최저가_적정성'] = '적정';
        row['HITL필요'] = false;
        row['처리상태'] = '자동완료';
      }
    }

    // Set approval status
    row['승인상태'] = row['처리상태'] === '자동완료' ? '승인대기' : '검토대기';
  });

  // Calculate summary
  const autoComplete = quotationData.filter(r => r['처리상태'] === '자동완료').length;
  const needReview = quotationData.filter(r => r['처리상태'] === '검토필요').length;
  
  addLog(`자동완료: ${autoComplete}건, 검토필요: ${needReview}건`);

  // Sort by urgency
  quotationData.sort((a, b) => {
    const urgencyOrder = { '긴급': 0, '일반': 1, '여유': 2 };
    return (urgencyOrder[a['긴급도']] || 1) - (urgencyOrder[b['긴급도']] || 1);
  });

  updateStatus(7, '처리 완료', 100);
  addLog(`총 처리 시간: ${((Date.now() - startTime) / 1000).toFixed(2)}초`);

  return {
    summary: {
      total: quotationData.length,
      totalPR: workingData.length,
      pzafCount: pzafData.length,
      urgent: urgencySummary.urgent,
      normal: urgencySummary.normal,
      flexible: urgencySummary.flexible,
      autoComplete,
      needReview,
      contractSummary,
      priceMethodSummary: priceMethods,
      llmCalls: 0, // LLM 기능 비활성화
      processingTime: ((Date.now() - startTime) / 1000).toFixed(2)
    },
    allPRData,    // 전체 PR 데이터 (Step 1~3용)
    quotationData,              // PZAF 필터링된 견적 데이터 (Step 4~8용)
    invalidPR: invalidData,
    emailLogs: globalState.emailLogs,
    llmLogs: globalState.llmLogs
  };
}

function updateStatus(step, name, progress = null) {
  globalState.processingStatus.step = step;
  globalState.processingStatus.currentStepName = name;
  globalState.processingStatus.progress = progress || Math.round((step / 7) * 100);
}

function generatePriceEstimationPrompt(row, poHistory) {
  const materialKey = row['자재번호_키'] || '';
  const similarMaterials = poHistory
    .filter(po => String(po['자재번호_키'] || '').substring(0, 6) === materialKey.substring(0, 6))
    .slice(0, 5);

  let similarInfo = '';
  if (similarMaterials.length > 0) {
    similarMaterials.forEach(sim => {
      const unitPrice = (sim['발주금액(KRW)-변환'] || 0) / (sim['발주수량'] || 1);
      similarInfo += `\n        - 자재: ${String(sim['자재내역'] || '').substring(0, 40)}
          단가: ${unitPrice.toLocaleString()}원, 발주수량: ${sim['발주수량']}`;
    });
  } else {
    similarInfo = '\n        (유사 자재 없음)';
  }

  return `당신은 조선/해양 산업의 구매 전문가입니다.

## 입찰 예정가 산정 요청

### 대상 자재
- 자재번호: ${row['자재번호'] || ''}
- 자재내역: ${row['내역'] || ''}
- 요청수량: ${row['요청수량'] || ''} ${row['UOM'] || ''}
- 소싱그룹: ${row['소싱그룹'] || ''}

### 유사 자재 발주실적${similarInfo}

### 요청
위 자재의 적정 입찰 예정가를 산정해주세요.

응답 형식:
\`\`\`json
{
    "예정단가": <숫자>,
    "산정근거": "<설명>",
    "신뢰도": "<상/중/하>"
}
\`\`\``;
}

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 PR→PO Agent Server running on port ${PORT}`);
  console.log(`📅 Simulation Date: ${CONFIG.SIMULATION_DATE.toISOString().split('T')[0]}`);
  console.log(`🧠 LLM: ${process.env.ANTHROPIC_API_KEY ? 'Enabled' : 'Disabled (no API key)'}`);
  
  // 서버 시작 시 도면 데이터 로드
  loadDrawingsData();
});
