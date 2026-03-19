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

const IDB_NAME = 'AIClipboard';
const IDB_STORE = 'images';

async function saveImagesToIDB(images) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ id: 'latest', data: images });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Failed to save images to IndexedDB'));
      };
    };
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function loadImagesFromIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(IDB_STORE, 'readonly');
      const getReq = tx.objectStore(IDB_STORE).get('latest');
      getReq.onsuccess = () => {
        db.close();
        resolve(getReq.result?.data || []);
      };
      getReq.onerror = () => {
        db.close();
        reject(getReq.error || new Error('Failed to load images from IndexedDB'));
      };
    };
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function clearIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Failed to clear IndexedDB'));
      };
    };
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

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
    // Reset previous data first to prevent stale paste.
    await chrome.storage.local.remove([
      'extractedText',
      'extractedFrom',
      'extractedAt'
    ]);
    await clearIDB();

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
      const hasData = Boolean(response.text) || Boolean(response.images && response.images.length > 0);
      if (!hasData) {
        showNotification('추출 실패', '추출된 데이터가 없습니다.');
        return;
      }

      // Compress images before saving to IndexedDB.
      const compressedImages = await compressViaOffscreen(response.images || []);

      // Images -> IndexedDB
      await saveImagesToIDB(compressedImages);

      // Text metadata -> storage
      await chrome.storage.local.set({
        extractedText: response.text || '',
        extractedFrom: siteInfo.name,
        extractedAt: new Date().toISOString()
      });

      const textLen = response.text ? response.text.length : 0;
      const imgLen = compressedImages.length;
      showNotification('추출 완료!', `텍스트: ${textLen}자, 이미지: ${imgLen}개`);
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
    if (tab.status !== 'complete') {
      showNotification('붙여넣기 실패', '페이지 로딩 중입니다. 잠시 후 다시 시도해주세요.');
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

    const stored = await chrome.storage.local.get(['extractedText']);
    const images = await loadImagesFromIDB();
    const payload = {
      text: stored.extractedText || '',
      images
    };

    if (!payload.text && payload.images.length === 0) {
      showNotification('붙여넣기 실패', '저장된 데이터가 없습니다. 다시 추출해주세요.');
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

async function compressViaOffscreen(images, maxSize = 800, quality = 0.6) {
  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      action: 'compress',
      images,
      maxSize,
      quality
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
  const savedText = text || '';
  let savedImages = Array.isArray(images) ? [...images] : [];

  // Approximate bytes from data URL strings and text size.
  const estimateBytes = (imgs) => {
    const textBytes = savedText.length * 2;
    const imageBytes = imgs.reduce((sum, img) => {
      if (typeof img !== 'string') return sum;
      return sum + img.length;
    }, 0);
    return textBytes + imageBytes;
  };

  const SAFE_LIMIT = 8 * 1024 * 1024;

  // Stage 1: if estimated size is too large, re-compress more aggressively.
  if (estimateBytes(savedImages) > SAFE_LIMIT) {
    console.warn('Estimated payload too large, trying stronger compression');
    savedImages = await compressViaOffscreen(savedImages, 400, 0.4);
  }

  // Stage 2: if still large, remove the biggest images first.
  while (estimateBytes(savedImages) > SAFE_LIMIT && savedImages.length > 0) {
    savedImages.sort((a, b) => {
      const lenA = typeof a === 'string' ? a.length : 0;
      const lenB = typeof b === 'string' ? b.length : 0;
      return lenB - lenA;
    });
    savedImages.shift();
    console.warn(`Dropped one large image, remaining: ${savedImages.length}`);
  }

  // Stage 3: final save; if quota still fails, keep text only.
  try {
    await chrome.storage.local.set({
      extractedText: savedText,
      extractedImages: savedImages,
      extractedFrom: from,
      extractedAt: new Date().toISOString()
    });
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    await chrome.storage.local.set({
      extractedText: savedText,
      extractedImages: [],
      extractedFrom: from,
      extractedAt: new Date().toISOString()
    });
    return {
      savedText,
      savedImages: [],
      originalImageCount,
      reduced: true
    };
  }

  return {
    savedText,
    savedImages,
    originalImageCount,
    reduced: savedImages.length !== originalImageCount
  };
}

