/**
 * AI Clipboard - 팝업 스크립트
 */

// 지원 사이트 정보
const SUPPORTED_SITES = {
  'chat.openai.com': { name: 'ChatGPT', icon: '🤖' },
  'chatgpt.com': { name: 'ChatGPT', icon: '🤖' },
  'claude.ai': { name: 'Claude', icon: '🟠' },
  'gemini.google.com': { name: 'Gemini', icon: '✨' },
  'perplexity.ai': { name: 'Perplexity', icon: '🔍' },
  'www.perplexity.ai': { name: 'Perplexity', icon: '🔍' }
};

// DOM 요소
const siteInfo = document.getElementById('site-info');
const siteIcon = document.getElementById('site-icon');
const siteName = document.getElementById('site-name');
const extractBtn = document.getElementById('extract-btn');
const pasteBtn = document.getElementById('paste-btn');
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
        if (hostname === domain || hostname.endsWith(`.${domain}`)) {
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
    pasteBtn.disabled = false;
  } else {
    siteIcon.textContent = '🌐';
    siteName.textContent = '지원되지 않는 사이트';
    siteInfo.classList.add('unsupported');
    siteInfo.classList.remove('supported');
    extractBtn.disabled = true;
    pasteBtn.disabled = true;
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

  // 붙여넣기 버튼
  pasteBtn.addEventListener('click', handlePaste);
  
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
 * 저장된 데이터 붙여넣기
 */
async function handlePaste() {
  if (!currentTab || !currentSite) return;

  showStatus('붙여넣기 중...', '⏳');
  pasteBtn.disabled = true;

  try {
    const data = await chrome.storage.local.get(['extractedText', 'extractedImages']);
    const payload = {
      text: data.extractedText || '',
      images: data.extractedImages || []
    };

    if (!payload.text && payload.images.length === 0) {
      showStatus('먼저 추출을 실행하세요.', '⚠️', 'error');
      return;
    }

    let response;

    try {
      response = await chrome.tabs.sendMessage(currentTab.id, {
        action: 'paste',
        payload
      });
    } catch (e) {
      // content script 주입 후 재시도
      let scriptFile = 'content/chatgpt.js';
      if (currentSite.domain.includes('claude')) {
        scriptFile = 'content/claude.js';
      } else if (currentSite.domain.includes('gemini')) {
        scriptFile = 'content/gemini.js';
      } else if (currentSite.domain.includes('perplexity')) {
        scriptFile = 'content/perplexity.js';
      }

      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: ['content/paste-helper.js', scriptFile]
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      response = await chrome.tabs.sendMessage(currentTab.id, {
        action: 'paste',
        payload
      });
    }

    if (response?.success) {
      const textLabel = payload.text ? '텍스트 입력' : '텍스트 없음';
      const imageLabel = payload.images.length > 0
        ? `이미지 ${response.uploadedCount || 0}/${payload.images.length}개`
        : '이미지 없음';

      if (response.warning) {
        showStatus(`${textLabel}, ${imageLabel} (${response.warning})`, '⚠️', 'error');
      } else {
        showStatus(`${textLabel}, ${imageLabel} 반영`, '✅', 'success');
      }
    } else {
      showStatus(response?.error || '붙여넣기 실패', '❌', 'error');
    }
  } catch (error) {
    console.error('붙여넣기 오류:', error);
    showStatus('붙여넣기 실패: ' + error.message, '❌', 'error');
  } finally {
    pasteBtn.disabled = false;
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
