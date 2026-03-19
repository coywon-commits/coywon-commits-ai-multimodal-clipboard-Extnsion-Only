/**
 * AI Clipboard - 팝업 스크립트
 */

// 지원 사이트 정보
const SUPPORTED_SITES = {
  'chat.openai.com': { name: 'ChatGPT', icon: '🤖' },
  'chatgpt.com': { name: 'ChatGPT', icon: '🤖' },
  'claude.ai': { name: 'Claude', icon: '🟠' },
  'gemini.google.com': { name: 'Gemini', icon: '✨' },
  'www.perplexity.ai': { name: 'Perplexity', icon: '🔍' }
};

// DOM 요소
const siteInfo = document.getElementById('site-info');
const siteIcon = document.getElementById('site-icon');
const siteName = document.getElementById('site-name');
const extractBtn = document.getElementById('extract-btn');
const status = document.getElementById('status');
const statusIcon = status.querySelector('.status-icon');
const statusText = status.querySelector('.status-text');
const result = document.getElementById('result');
const textCount = document.getElementById('text-count');
const imageCount = document.getElementById('image-count');
const clearBtn = document.getElementById('clear-btn');
const settingsBtn = document.getElementById('settings-btn');

// 현재 탭 정보
let currentTab = null;
let currentSite = null;

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
  await checkCurrentTab();
  await loadStoredData();
  setupEventListeners();
});

/**
 * 현재 탭 확인
 */
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    
    if (tab && tab.url) {
      const url = new URL(tab.url);
      const hostname = url.hostname;
      
      // 지원 사이트 확인
      for (const [domain, info] of Object.entries(SUPPORTED_SITES)) {
        if (hostname.includes(domain) || hostname === domain) {
          currentSite = { domain, ...info };
          break;
        }
      }
    }
    
    updateSiteInfo();
  } catch (error) {
    console.error('탭 확인 오류:', error);
  }
}

/**
 * 사이트 정보 업데이트
 */
function updateSiteInfo() {
  if (currentSite) {
    siteIcon.textContent = currentSite.icon;
    siteName.textContent = currentSite.name;
    siteInfo.classList.add('supported');
    siteInfo.classList.remove('unsupported');
    extractBtn.disabled = false;
  } else {
    siteIcon.textContent = '🌐';
    siteName.textContent = '지원되지 않는 사이트';
    siteInfo.classList.add('unsupported');
    siteInfo.classList.remove('supported');
    extractBtn.disabled = true;
  }
}

/**
 * 저장된 데이터 로드
 */
async function loadStoredData() {
  try {
    const data = await chrome.storage.local.get(['extractedText', 'extractedImages']);
    
    if (data.extractedText || (data.extractedImages && data.extractedImages.length > 0)) {
      showResult(
        data.extractedText ? data.extractedText.length : 0,
        data.extractedImages ? data.extractedImages.length : 0
      );
    }
  } catch (error) {
    console.error('데이터 로드 오류:', error);
  }
}

/**
 * 이벤트 리스너 설정
 */
function setupEventListeners() {
  // 추출 버튼
  extractBtn.addEventListener('click', handleExtract);
  
  // 초기화 버튼
  clearBtn.addEventListener('click', handleClear);
  
  // 설정 버튼
  settingsBtn.addEventListener('click', () => {
    // TODO: 설정 페이지 열기
    alert('설정 기능은 추후 추가 예정입니다.');
  });
}

/**
 * 추출 실행
 */
async function handleExtract() {
  if (!currentTab || !currentSite) return;
  
  showStatus('추출 중...', '⏳');
  extractBtn.disabled = true;
  
  try {
    let response;
    
    try {
      // Content Script에 메시지 전송 시도
      response = await chrome.tabs.sendMessage(currentTab.id, {
        action: 'extract'
      });
    } catch (e) {
      // Content script가 없으면 직접 주입
      console.log('Content script 없음, 주입 시도...');
      showStatus('스크립트 주입 중...', '⏳');
      
      // Content script 파일 결정
      let scriptFile = 'content/chatgpt.js';
      if (currentSite.domain.includes('claude')) {
        scriptFile = 'content/claude.js';
      } else if (currentSite.domain.includes('gemini')) {
        scriptFile = 'content/gemini.js';
      } else if (currentSite.domain.includes('perplexity')) {
        scriptFile = 'content/perplexity.js';
      }
      
      // 스크립트 주입
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: [scriptFile]
      });
      
      // 잠시 대기 후 다시 시도
      await new Promise(resolve => setTimeout(resolve, 500));
      
      response = await chrome.tabs.sendMessage(currentTab.id, {
        action: 'extract'
      });
    }
    
    if (response && response.success) {
      // 추출된 데이터 저장
      await chrome.storage.local.set({
        extractedText: response.text,
        extractedImages: response.images,
        extractedFrom: currentSite.name,
        extractedAt: new Date().toISOString()
      });
      
      // 로컬 파일로 저장 (Python 앱용)
      await saveToLocalStorage(response.text, response.images);
      
      showStatus('추출 완료!', '✅', 'success');
      showResult(
        response.text ? response.text.length : 0,
        response.images ? response.images.length : 0
      );
    } else {
      showStatus(response?.error || '추출 실패', '❌', 'error');
    }
  } catch (error) {
    console.error('추출 오류:', error);
    showStatus('추출 실패: ' + error.message, '❌', 'error');
  }
  
  extractBtn.disabled = false;
}

/**
 * Python 앱으로 직접 전송
 * HTTP 서버를 통해 데이터 전송 (다운로드 대화상자 없음)
 */
async function saveToLocalStorage(text, images) {
  const SERVER_URL = 'http://127.0.0.1:5757';
  
  try {
    // 먼저 서버가 실행 중인지 확인
    try {
      const statusRes = await fetch(`${SERVER_URL}/status`, { method: 'GET' });
      if (!statusRes.ok) {
        throw new Error('서버 응답 없음');
      }
    } catch (e) {
      console.warn('Python 앱이 실행되지 않음:', e);
      showStatus('Python 앱을 먼저 실행하세요!', '⚠️', 'error');
      return;
    }
    
    // 데이터 전송
    const data = {
      text: text || '',
      images: images || [],
      extractedAt: new Date().toISOString()
    };
    
    const response = await fetch(`${SERVER_URL}/data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      throw new Error(`서버 오류: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('데이터 전송 성공:', result);
    
  } catch (error) {
    console.error('데이터 전송 오류:', error);
    showStatus('전송 실패: ' + error.message, '❌', 'error');
  }
}

/**
 * 데이터 초기화
 */
async function handleClear() {
  try {
    await chrome.storage.local.remove([
      'extractedText',
      'extractedImages',
      'extractedFrom',
      'extractedAt'
    ]);
    
    result.classList.add('hidden');
    status.classList.add('hidden');
    
    showStatus('초기화 완료', '✅', 'success');
    setTimeout(() => status.classList.add('hidden'), 2000);
  } catch (error) {
    console.error('초기화 오류:', error);
  }
}

/**
 * 상태 표시
 */
function showStatus(message, icon = '⏳', state = '') {
  status.classList.remove('hidden', 'success', 'error');
  if (state) {
    status.classList.add(state);
  }
  statusIcon.textContent = icon;
  statusText.textContent = message;
}

/**
 * 결과 표시
 */
function showResult(textLen, imageLen) {
  result.classList.remove('hidden');
  textCount.textContent = textLen > 0 ? `${textLen}자` : '없음';
  imageCount.textContent = imageLen > 0 ? `${imageLen}개` : '없음';
}
