/**
 * AI Clipboard - Gemini 추출 스크립트
 * 가장 최근 입력 상태만 추출 (입력창 또는 마지막 내 메시지)
 */

console.log('AI Clipboard: Gemini content script 로드됨');

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
  
  // Gemini 입력창 찾기
  const inputSelectors = [
    '[contenteditable="true"]',
    'textarea',
    'rich-textarea'
  ];
  
  let inputArea = null;
  for (const selector of inputSelectors) {
    inputArea = document.querySelector(selector);
    if (inputArea) {
      const content = inputArea.value || inputArea.innerText;
      if (content && content.trim()) break;
    }
  }
  
  if (inputArea) {
    text = (inputArea.value || inputArea.innerText || '').trim();
  }
  
  console.log('=== Gemini 이미지 검색 시작 ===');
  
  // 입력창 컨테이너 찾기 (첨부 이미지가 있는 영역)
  // X 버튼이 있는 이미지 = 사용자가 첨부한 이미지
  const closeButtons = document.querySelectorAll('button[aria-label*="삭제"], button[aria-label*="Remove"], button[aria-label*="Close"], [class*="close"], [class*="remove"]');
  console.log('닫기 버튼 개수:', closeButtons.length);
  
  for (const btn of closeButtons) {
    // 버튼의 부모에서 이미지 찾기
    const parent = btn.parentElement;
    if (parent) {
      const img = parent.querySelector('img') || parent.previousElementSibling?.querySelector('img') || parent.parentElement?.querySelector('img');
      if (img) {
        console.log('첨부 이미지 발견:', img.src?.substring(0, 80));
        const dataUrl = await imageToDataUrl(img);
        if (dataUrl && !images.includes(dataUrl)) {
          images.push(dataUrl);
        }
      }
    }
  }
  
  // 방법 2: 입력 영역 근처의 미리보기 이미지 찾기
  if (images.length === 0) {
    console.log('닫기 버튼으로 못 찾음, 입력 영역 검색...');
    
    // form이나 입력 컨테이너 찾기
    const inputContainer = document.querySelector('form') || 
                           inputArea?.closest('div')?.parentElement?.parentElement;
    
    if (inputContainer) {
      const containerImages = inputContainer.querySelectorAll('img');
      for (const img of containerImages) {
        const w = img.width || img.naturalWidth || 100;
        const h = img.height || img.naturalHeight || 100;
        
        // 40px 이상이고 정사각형에 가까운 이미지 (썸네일)
        if (w >= 40 && h >= 40) {
          // blob: 또는 data: URL은 사용자 첨부 이미지일 가능성 높음
          if (img.src?.startsWith('blob:') || img.src?.startsWith('data:')) {
            console.log('첨부 이미지 후보:', img.src?.substring(0, 80));
            const dataUrl = await imageToDataUrl(img);
            if (dataUrl && !images.includes(dataUrl)) {
              images.push(dataUrl);
            }
          }
        }
      }
    }
  }
  
  // 방법 3: blob: URL 이미지 찾기 (사용자 업로드는 보통 blob)
  if (images.length === 0) {
    console.log('blob: URL 이미지 검색...');
    const allImages = document.querySelectorAll('img[src^="blob:"]');
    for (const img of allImages) {
      console.log('blob 이미지 발견:', img.src);
      const dataUrl = await imageToDataUrl(img);
      if (dataUrl && !images.includes(dataUrl)) {
        images.push(dataUrl);
      }
    }
  }
  
  console.log('=== 결과: 텍스트', text.length, '자, 이미지', images.length, '개 ===');
  return { text, images };
}

/**
 * 마지막 사용자 메시지 추출
 */
async function extractLastUserMessage() {
  let text = '';
  let images = [];
  
  // Gemini 사용자 메시지 찾기
  const userMessageSelectors = [
    '[class*="query"]',
    '[class*="user"]',
    '[class*="human"]',
    'user-query'
  ];
  
  let userMessages = [];
  for (const selector of userMessageSelectors) {
    userMessages = document.querySelectorAll(selector);
    if (userMessages.length > 0) break;
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
