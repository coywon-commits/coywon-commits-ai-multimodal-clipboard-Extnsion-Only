/**
 * AI Clipboard - 백그라운드 서비스 워커
 */

// 지원 사이트 정보
const SUPPORTED_SITES = {
  'chat.openai.com': { name: 'ChatGPT', script: 'content/chatgpt.js' },
  'chatgpt.com': { name: 'ChatGPT', script: 'content/chatgpt.js' },
  'claude.ai': { name: 'Claude', script: 'content/claude.js' },
  'gemini.google.com': { name: 'Gemini', script: 'content/gemini.js' },
  'perplexity.ai': { name: 'Perplexity', script: 'content/perplexity.js' },
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
  } else if (command === 'paste') {
    await handlePasteCommand();
  }
});

/**
 * 추출 명령 처리 (단축키)
 */
async function handleExtractCommand() {
  try {
    // Always reset previous data first to prevent stale paste.
    await chrome.storage.local.remove([
      'extractedText',
      'extractedImages',
      'extractedFrom',
      'extractedAt'
    ]);

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
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
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
      const hasExtractedData = Boolean(response.text) || Boolean(response.images && response.images.length > 0);
      if (!hasExtractedData) {
        await chrome.storage.local.remove([
          'extractedText',
          'extractedImages',
          'extractedFrom',
          'extractedAt'
        ]);
        showNotification('추출 실패', '추출된 데이터가 없어 기존 저장 데이터를 초기화했습니다.');
        return;
      }

      // Use offscreen document to compress images for shortcut path too.
      const compressedImages = await compressViaOffscreen(response.images || []);

      // 데이터 저장 (quota 초과 시 이미지 수 자동 축소)
      const saveResult = await saveExtractedDataSafely({
        text: response.text,
        images: compressedImages,
        from: siteInfo.name
      });
      
      const textLen = saveResult.savedText ? saveResult.savedText.length : 0;
      const imgLen = saveResult.savedImages ? saveResult.savedImages.length : 0;
      let message = `텍스트: ${textLen}자, 이미지: ${imgLen}개`;
      if (saveResult.reduced) {
        message += ` (원본 ${saveResult.originalImageCount}개에서 축소 저장)`;
      }
      showNotification('추출 완료!', message);
    } else {
      showNotification('추출 실패', response?.error || '알 수 없는 오류');
    }
    
  } catch (error) {
    console.error('추출 명령 오류:', error);
    showNotification('추출 실패', error.message);
  }
}

async function handlePasteCommand() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      showNotification('붙여넣기 실패', '탭 정보를 가져올 수 없습니다.');
      return;
    }

    const url = new URL(tab.url);
    const hostname = url.hostname;

    let siteInfo = null;
    for (const [domain, info] of Object.entries(SUPPORTED_SITES)) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        siteInfo = { domain, ...info };
        break;
      }
    }

    if (!siteInfo) {
      showNotification('붙여넣기 실패', '지원되지 않는 사이트입니다.');
      return;
    }

    const stored = await chrome.storage.local.get(['extractedText', 'extractedImages']);
    const payload = {
      text: stored.extractedText || '',
      images: stored.extractedImages || []
    };

    if (!payload.text && payload.images.length === 0) {
      showNotification('붙여넣기 실패', '저장된 데이터가 없습니다.');
      return;
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: 'paste', payload });
    } catch (e) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/paste-helper.js', siteInfo.script]
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      response = await chrome.tabs.sendMessage(tab.id, { action: 'paste', payload });
    }

    if (response?.success) {
      const uploaded = response.uploadedCount || 0;
      showNotification('붙여넣기 완료', `텍스트/이미지 반영 (${uploaded}개 업로드)`);
    } else {
      showNotification('붙여넣기 실패', response?.error || '알 수 없는 오류');
    }
  } catch (error) {
    console.error('붙여넣기 명령 오류:', error);
    showNotification('붙여넣기 실패', error.message);
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

  // Offscreen compressor handles this action.
  if (message?.action === 'compress') {
    return false;
  }
  
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

function isQuotaExceededError(error) {
  const msg = String(error?.message || error || '');
  return msg.includes('QUOTA') || msg.includes('kQuotaBytes');
}

let offscreenCreating = null;
async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url,
    reasons: ['BLOBS'],
    justification: 'Compress images before saving to extension storage'
  });
  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

async function compressViaOffscreen(images) {
  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      action: 'compress',
      images,
      maxSize: 800,
      quality: 0.6
    });
    if (response?.success && Array.isArray(response.compressed)) {
      return response.compressed;
    }
    return images;
  } catch (e) {
    console.warn('offscreen compress fallback to original images:', e);
    return images;
  }
}

async function saveExtractedDataSafely({ text, images, from }) {
  const originalImageCount = Array.isArray(images) ? images.length : 0;
  let savedImages = Array.isArray(images) ? [...images] : [];
  const savedText = text || '';

  while (true) {
    try {
      await chrome.storage.local.set({
        extractedText: savedText,
        extractedImages: savedImages,
        extractedFrom: from,
        extractedAt: new Date().toISOString()
      });
      return {
        savedText,
        savedImages,
        originalImageCount,
        reduced: savedImages.length !== originalImageCount
      };
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error;
      if (savedImages.length === 0) {
        throw new Error('저장 용량 초과: 이미지를 저장할 수 없습니다.');
      }
      const nextLen = Math.floor(savedImages.length / 2);
      savedImages = savedImages.slice(0, Math.max(nextLen, 0));
    }
  }
}

