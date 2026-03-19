/**
 * AI Clipboard - Claude 추출 스크립트
 * 가장 최근 입력 상태만 추출 (입력창 또는 마지막 내 메시지)
 */

console.log('AI Clipboard: Claude content script 로드됨');

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
  
  // Claude 입력창 찾기
  const inputSelectors = [
    '[contenteditable="true"]',
    'div[class*="ProseMirror"]',
    'textarea',
    '[data-placeholder]'
  ];
  
  let inputArea = null;
  for (const selector of inputSelectors) {
    inputArea = document.querySelector(selector);
    if (inputArea && inputArea.innerText.trim()) break;
  }
  
  if (inputArea) {
    text = inputArea.innerText.trim();
  }
  
  // 입력창 근처의 첨부된 이미지 찾기
  const inputContainer = document.querySelector('form') || 
                         document.querySelector('[class*="composer"]') ||
                         document.querySelector('[class*="input-container"]');
  
  if (inputContainer) {
    const attachedImages = inputContainer.querySelectorAll('img');
    for (const img of attachedImages) {
      if (img.width < 30 || img.height < 30) continue;
      if (img.closest('button')) continue;
      
      const dataUrl = await imageToDataUrl(img);
      if (dataUrl) images.push(dataUrl);
    }
  }
  
  return { text, images };
}

/**
 * 마지막 사용자 메시지 추출
 */
async function extractLastUserMessage() {
  let text = '';
  let images = [];
  
  // Claude 사용자 메시지 찾기 (여러 선택자 시도)
  const userMessageSelectors = [
    '[class*="human-message"]',
    '[class*="user-message"]',
    '[data-is-user="true"]',
    '.human'
  ];
  
  let userMessages = [];
  for (const selector of userMessageSelectors) {
    userMessages = document.querySelectorAll(selector);
    if (userMessages.length > 0) break;
  }
  
  // 선택자로 못 찾으면 구조로 추측
  if (userMessages.length === 0) {
    const allMessages = document.querySelectorAll('[class*="message"]');
    userMessages = Array.from(allMessages).filter(msg => {
      const classes = msg.className.toLowerCase();
      return classes.includes('human') || classes.includes('user');
    });
  }
  
  if (userMessages.length === 0) {
    return { text: '', images: [] };
  }
  
  // 마지막 사용자 메시지
  const lastMessage = userMessages[userMessages.length - 1];
  
  // 텍스트 추출
  text = lastMessage.innerText.trim();
  
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
