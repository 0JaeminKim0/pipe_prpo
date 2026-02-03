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

// Configuration
const CONFIG = {
  SIMULATION_DATE: new Date('2026-01-01'),
  REQUIRED_COLUMNS: ['구매요청', '자재번호', '내역', '구매요청일', 'PR납기일', 'LEAD_TIME', '소싱그룹', '자재그룹'],
  URGENCY_URGENT: 2,
  URGENCY_NORMAL: 5,
  REASON_DESIGNATED: 'AC002_2: 계약의 성질 또는 목적에 비추어 특수한 설비/자재/물품 또는 실적이 있는 자가 아니면 계약의 목적을 달성하기 곤란한 경우로서 입찰대상자가 10인 이내인 경우',
  REASON_PRIVATE: 'SV023_2: 계약 목적의 특성 상 경쟁입찰에 부칠 수 없거나 경쟁입찰에 부칠 경우 현저하게 불리하다고 인정 되는 경우',
  LLM_MODEL: 'claude-sonnet-4-20250514'
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

function calculateDaysDiff(date1, date2) {
  if (!date1 || !date2) return null;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
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
  try {
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (match) {
      return JSON.parse(match[1]);
    }
    const jsonMatch = text.match(/\{[^{}]*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('JSON parse error:', e);
  }
  return {};
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
// Main Agent Processing Logic
// =============================================================================

async function processAgent() {
  const startTime = Date.now();
  let workingData = [...globalState.prData];
  const poHistory = [...globalState.poHistory];
  
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
      const daysUntilDeadline = calculateDaysDiff(prDeadline, CONFIG.SIMULATION_DATE);
      row['납기까지일수'] = daysUntilDeadline;
      row['실제잔여일수'] = daysUntilDeadline - leadTime;
      
      if (row['실제잔여일수'] <= CONFIG.URGENCY_URGENT) {
        row['긴급도'] = '긴급';
        row['긴급도_신호'] = '🔴';
      } else if (row['실제잔여일수'] <= CONFIG.URGENCY_NORMAL) {
        row['긴급도'] = '일반';
        row['긴급도_신호'] = '🟡';
      } else {
        row['긴급도'] = '여유';
        row['긴급도_신호'] = '🟢';
      }
    } else {
      row['긴급도'] = '일반';
      row['긴급도_신호'] = '🟡';
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

  // Price estimation
  addLog('입찰 예정가 산정 중...');
  const poUnitPrices = {};
  poHistory.forEach(row => {
    const key = row['자재번호_키'];
    const qty = parseFloat(row['발주수량']) || 1;
    const amount = parseFloat(row['발주금액(KRW)-변환']) || 0;
    if (!poUnitPrices[key]) {
      poUnitPrices[key] = [];
    }
    poUnitPrices[key].push(amount / qty);
  });

  let llmCallCount = 0;
  for (const row of quotationData) {
    const key = row['자재번호_키'];
    const desc = String(row['내역'] || '').trim().toUpperCase();
    const qty = parseFloat(row['요청수량']) || 1;
    
    // Find matching price
    const matchKey = `${key}_${desc}`;
    const exactMatch = poLookup[matchKey];
    
    if (exactMatch) {
      const matchQty = parseFloat(exactMatch['발주수량']) || 1;
      const matchAmount = parseFloat(exactMatch['발주금액(KRW)-변환']) || 0;
      const unitPrice = matchAmount / matchQty;
      row['입찰예정가'] = Math.round(unitPrice * qty);
      row['예정가_산정방법'] = '자재+내역 일치';
      row['최근발주단가'] = unitPrice;
    } else if (poUnitPrices[key] && poUnitPrices[key].length > 0) {
      const avgPrice = poUnitPrices[key].reduce((a, b) => a + b, 0) / poUnitPrices[key].length;
      row['입찰예정가'] = Math.round(avgPrice * qty);
      row['예정가_산정방법'] = '그룹 평균';
      row['최근발주단가'] = avgPrice;
    } else {
      // Try LLM for new materials
      if (process.env.ANTHROPIC_API_KEY && llmCallCount < 10) {
        addLog(`🧠 LLM 호출: ${row['자재번호']} 예정가 산정...`);
        const prompt = generatePriceEstimationPrompt(row, poHistory);
        const response = await callLLM(prompt);
        const result = parseLLMJson(response);
        
        if (result && result['예정단가']) {
          row['입찰예정가'] = Math.round(parseFloat(result['예정단가']) * qty);
          row['예정가_산정방법'] = 'LLM 산정';
          row['LLM응답'] = result;
          globalState.llmLogs.push({
            step: 'S12',
            pr: row['구매요청'],
            material: row['자재번호'],
            result
          });
          llmCallCount++;
        } else {
          row['입찰예정가'] = 1000000;
          row['예정가_산정방법'] = '기본값';
        }
      } else {
        row['입찰예정가'] = 1000000;
        row['예정가_산정방법'] = '기본값';
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
      urgent: urgencySummary.urgent,
      normal: urgencySummary.normal,
      flexible: urgencySummary.flexible,
      autoComplete,
      needReview,
      contractSummary,
      priceMethodSummary: priceMethods,
      llmCalls: llmCallCount,
      processingTime: ((Date.now() - startTime) / 1000).toFixed(2)
    },
    quotationData,
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
});
