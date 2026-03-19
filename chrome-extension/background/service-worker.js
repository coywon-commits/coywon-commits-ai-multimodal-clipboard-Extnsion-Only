/**
 * AI Clipboard - 백그라운드 서비스 워커
 */

const SERVER_URL = 'http://127.0.0.1:5757';

// 지원 사이트 정보
const SUPPORTED_SITES = {
  'chat.openai.com': { name: 'ChatGPT', script: 'content/chatgpt.js' },
  'chatgpt.com': { name: 'ChatGPT', script: 'content/chatgpt.js' },
  'claude.ai': { name: 'Claude', script: 'content/claude.js' },
  'gemini.google.com': { name: 'Gemini', script: 'content/gemini.js' },
  'www.perplexity.ai': { name: 'Perplexity', script: 'content/perplexity.js' }
};

// 확장 설치/업데이트 시
chrome.runtime.onInstalled.addListener((details) => {
  console.log('AI Clipboard 확장 설치됨:', details.reason);
  
  // 기본 설정 저장
  chrome.storage.local.set({
    settings: {
      textDelay: 300,
      imageDelay: 500,
      autoSave: true
    }
  });
});

// 단축키 명령 처리
chrome.commands.onCommand.addListener(async (command) => {
  console.log('단축키 명령:', command);
  
  if (command === 'extract') {
    await handleExtractCommand();
  }
});

/**
 * 추출 명령 처리 (단축키)
 */
async function handleExtractCommand() {
  try {
    // 현재 활성 탭 가져오기
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.url) {
      showNotification('추출 실패', '탭 정보를 가져올 수 없습니다.');
      return;
    }
    
    // 지원 사이트 확인
    const url = new URL(tab.url);
    const hostname = url.hostname;
    
    let siteInfo = null;
    for (const [domain, info] of Object.entries(SUPPORTED_SITES)) {
      if (hostname.includes(domain) || hostname === domain) {
        siteInfo = { domain, ...info };
        break;
      }
    }
    
    if (!siteInfo) {
      showNotification('추출 실패', '지원되지 않는 사이트입니다.');
      return;
    }
    
    // Content script에 추출 요청
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: 'extract' });
    } catch (e) {
      // Content script가 없으면 주입
      console.log('Content script 없음, 주입 시도...');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [siteInfo.script]
      });
      
      await new Promise(resolve => setTimeout(resolve, 500));
      response = await chrome.tabs.sendMessage(tab.id, { action: 'extract' });
    }
    
    if (response && response.success) {
      // 데이터 저장
      await chrome.storage.local.set({
        extractedText: response.text,
        extractedImages: response.images,
        extractedFrom: siteInfo.name,
        extractedAt: new Date().toISOString()
      });
      
      // Python 앱으로 전송
      await sendToPythonApp(response.text, response.images);
      
      const textLen = response.text ? response.text.length : 0;
      const imgLen = response.images ? response.images.length : 0;
      showNotification('추출 완료!', `텍스트: ${textLen}자, 이미지: ${imgLen}개`);
    } else {
      showNotification('추출 실패', response?.error || '알 수 없는 오류');
    }
    
  } catch (error) {
    console.error('추출 명령 오류:', error);
    showNotification('추출 실패', error.message);
  }
}

/**
 * Python 앱으로 데이터 전송
 */
async function sendToPythonApp(text, images) {
  try {
    // 서버 상태 확인
    const statusRes = await fetch(`${SERVER_URL}/status`, { method: 'GET' });
    if (!statusRes.ok) {
      console.warn('Python 앱이 실행되지 않음');
      return;
    }
    
    // 데이터 전송
    const data = {
      text: text || '',
      images: images || [],
      extractedAt: new Date().toISOString()
    };
    
    await fetch(`${SERVER_URL}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
  } catch (error) {
    console.warn('Python 앱 전송 실패:', error);
  }
}

/**
 * 알림 표시 (뱃지 + 콘솔)
 */
async function showNotification(title, message) {
  console.log(`[${title}] ${message}`);
  
  // 뱃지로 상태 표시
  if (title.includes('완료')) {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  } else if (title.includes('실패')) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
  }
  
  // 3초 후 뱃지 제거
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
  }, 3000);
}

// 메시지 리스너
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('메시지 수신:', message);
  
  switch (message.action) {
    case 'getStoredData':
      handleGetStoredData(sendResponse);
      return true; // 비동기 응답
      
    case 'saveData':
      handleSaveData(message.data, sendResponse);
      return true;
      
    case 'clearData':
      handleClearData(sendResponse);
      return true;
      
    default:
      sendResponse({ error: '알 수 없는 액션' });
  }
});

/**
 * 저장된 데이터 가져오기
 */
async function handleGetStoredData(sendResponse) {
  try {
    const data = await chrome.storage.local.get([
      'extractedText',
      'extractedImages',
      'extractedFrom',
      'extractedAt'
    ]);
    sendResponse({ success: true, data });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * 데이터 저장
 */
async function handleSaveData(data, sendResponse) {
  try {
    await chrome.storage.local.set(data);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * 데이터 삭제
 */
async function handleClearData(sendResponse) {
  try {
    await chrome.storage.local.remove([
      'extractedText',
      'extractedImages',
      'extractedFrom',
      'extractedAt'
    ]);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// 다운로드 완료 감지
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === 'complete') {
    console.log('다운로드 완료:', delta.id);
  }
});
