/**
 * AI Clipboard - ChatGPT 추출 스크립트
 * 가장 최근 입력 상태만 추출 (입력창 또는 마지막 내 메시지)
 */

console.log('AI Clipboard: ChatGPT content script 로드됨');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extract') {
    extractLatestInput()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

/**
 * 가장 최근 입력 상태 추출
 */
async function extractLatestInput() {
  try {
    // 1. 먼저 입력창 확인
    const inputResult = await extractFromInputArea();
    
    if (inputResult.text || inputResult.images.length > 0) {
      return {
        success: true,
        text: inputResult.text,
        images: inputResult.images
      };
    }
    
    // 2. 입력창 비었으면 마지막 내 메시지 추출
    const lastMessageResult = await extractLastUserMessage();
    
    return {
      success: true,
      text: lastMessageResult.text,
      images: lastMessageResult.images
    };
    
  } catch (error) {
    console.error('추출 오류:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 입력창에서 추출
 */
async function extractFromInputArea() {
  let text = '';
  let images = [];
  
  // ChatGPT 입력창 찾기 (여러 선택자 시도)
  const inputSelectors = [
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'div[contenteditable="true"]',
    'textarea'
  ];
  
  let inputArea = null;
  for (const selector of inputSelectors) {
    inputArea = document.querySelector(selector);
    if (inputArea) break;
  }
  
  if (inputArea) {
    // 텍스트 추출
    if (inputArea.tagName === 'TEXTAREA') {
      text = inputArea.value.trim();
    } else {
      text = inputArea.innerText.trim();
    }
  }
  
  console.log('=== ChatGPT 이미지 검색 시작 ===');
  
  // 방법 1: X(닫기) 버튼이 있는 이미지 = 사용자 첨부 이미지
  const closeButtons = document.querySelectorAll('button[aria-label*="Remove"], button[aria-label*="삭제"], [class*="close"], [class*="remove"]');
  console.log('닫기 버튼 개수:', closeButtons.length);
  
  for (const btn of closeButtons) {
    // 버튼 근처에서 이미지 찾기
    const container = btn.closest('div');
    if (container) {
      const img = container.querySelector('img');
      if (img) {
        console.log('첨부 이미지 발견 (닫기 버튼):', img.src?.substring(0, 80));
        const dataUrl = await imageToDataUrl(img);
        if (dataUrl && !images.includes(dataUrl)) {
          images.push(dataUrl);
        }
      }
    }
  }
  
  // 방법 2: form 내 blob: URL 이미지 찾기
  if (images.length === 0) {
    console.log('blob: URL 이미지 검색...');
    const form = document.querySelector('form');
    if (form) {
      const formImages = form.querySelectorAll('img');
      for (const img of formImages) {
        // 채팅 기록 안의 이미지 제외
        if (img.closest('[data-message-author-role]')) continue;
        
        const w = img.width || img.naturalWidth || 100;
        const h = img.height || img.naturalHeight || 100;
        if (w >= 40 && h >= 40) {
          console.log('form 내 이미지:', img.src?.substring(0, 80));
          const dataUrl = await imageToDataUrl(img);
          if (dataUrl && !images.includes(dataUrl)) {
            images.push(dataUrl);
          }
        }
      }
    }
  }
  
  // 방법 3: blob: URL 이미지 전체 검색
  if (images.length === 0) {
    const blobImages = document.querySelectorAll('img[src^="blob:"]');
    for (const img of blobImages) {
      if (img.closest('[data-message-author-role]')) continue;
      console.log('blob 이미지 발견:', img.src);
      const dataUrl = await imageToDataUrl(img);
      if (dataUrl && !images.includes(dataUrl)) {
        images.push(dataUrl);
      }
    }
  }
  
  console.log('=== 최종 결과 - 텍스트:', text.length, '자, 이미지:', images.length, '개 ===');
  
  return { text, images };
}

/**
 * URL에서 이미지를 가져와 Data URL로 변환
 */
async function fetchImageAsDataUrl(url) {
  try {
    if (url.startsWith('data:')) return url;
    
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error('이미지 fetch 실패:', e);
    return null;
  }
}

/**
 * 마지막 사용자 메시지 추출
 */
async function extractLastUserMessage() {
  let text = '';
  let images = [];
  
  // 사용자 메시지 찾기
  const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
  
  if (userMessages.length === 0) {
    return { text: '', images: [] };
  }
  
  // 마지막 사용자 메시지
  const lastMessage = userMessages[userMessages.length - 1];
  
  // 텍스트 추출
  const textElement = lastMessage.querySelector('.whitespace-pre-wrap') ||
                      lastMessage.querySelector('[class*="message"]') ||
                      lastMessage;
  
  if (textElement) {
    text = textElement.innerText.trim();
  }
  
  // 이미지 추출
  const messageImages = lastMessage.querySelectorAll('img');
  for (const img of messageImages) {
    if (img.width < 50 || img.height < 50) continue;
    if (img.src.includes('avatar') || img.src.includes('profile')) continue;
    
    const dataUrl = await imageToDataUrl(img);
    if (dataUrl) images.push(dataUrl);
  }
  
  return { text, images };
}

/**
 * 이미지를 Data URL로 변환
 */
async function imageToDataUrl(img) {
  return new Promise((resolve) => {
    try {
      if (img.src.startsWith('data:')) {
        resolve(img.src);
        return;
      }
      
      if (img.src.startsWith('blob:')) {
        fetch(img.src)
          .then(res => res.blob())
          .then(blob => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          })
          .catch(() => resolve(null));
        return;
      }
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const newImg = new Image();
      newImg.crossOrigin = 'anonymous';
      
      newImg.onload = () => {
        canvas.width = newImg.naturalWidth || newImg.width;
        canvas.height = newImg.naturalHeight || newImg.height;
        ctx.drawImage(newImg, 0, 0);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch (e) {
          resolve(null);
        }
      };
      
      newImg.onerror = () => resolve(null);
      newImg.src = img.src;
      
    } catch (error) {
      resolve(null);
    }
  });
}
