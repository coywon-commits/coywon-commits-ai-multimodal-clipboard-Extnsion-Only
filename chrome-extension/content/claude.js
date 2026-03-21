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
 * Walk DOM + open shadow roots (Claude often nests the composer UI in shadow DOM).
 */
function walkElementsDeep(root, callback) {
  if (!root) return;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeType === Node.ELEMENT_NODE) {
      callback(node);
      if (node.shadowRoot) {
        stack.push(node.shadowRoot);
      }
    }
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i]);
    }
  }
}

function collectImagesDeep(root) {
  const imgs = [];
  walkElementsDeep(root, (el) => {
    if (el.tagName === 'IMG') imgs.push(el);
  });
  return imgs;
}

function getImgSrc(img) {
  return (img.currentSrc || img.src || '').trim();
}

function isSmallIconButton(img) {
  const btn = img.closest('button');
  if (!btn) return false;
  const r = btn.getBoundingClientRect();
  return r.width < 48 && r.height < 48;
}

/**
 * Pasted / pending uploads usually use blob: URLs; thumbnails can report 0x0 until decode.
 */
function isLikelyAttachmentImage(img) {
  const src = getImgSrc(img);
  if (!src || src.startsWith('chrome-extension')) return false;
  if (src.includes('avatar') || src.includes('profile') || src.includes('favicon')) return false;

  const r = img.getBoundingClientRect();
  const area = Math.max(1, r.width) * Math.max(1, r.height);
  const nw = img.naturalWidth || 0;
  const nh = img.naturalHeight || 0;
  const w = nw || r.width || 0;
  const h = nh || r.height || 0;
  if (area < 200 && w < 20 && h < 20) return false;
  if (isSmallIconButton(img)) return false;

  if (src.startsWith('blob:') || src.startsWith('data:')) return true;
  if (r.bottom < window.innerHeight * 0.08) return false;
  return w >= 32 || h >= 32 || area >= 800;
}

async function collectComposerImagesAggressive() {
  const roots = [
    document.querySelector('form'),
    document.querySelector('[class*="composer"]'),
    document.querySelector('[class*="Composer"]'),
    document.querySelector('[class*="footer"]'),
    document.querySelector('main'),
    document.body
  ].filter(Boolean);

  const seen = new Set();
  const out = [];

  for (const root of roots) {
    const imgs = collectImagesDeep(root);
    for (const img of imgs) {
      if (!isLikelyAttachmentImage(img)) continue;
      const key = getImgSrc(img) || `${img.getBoundingClientRect().x},${img.getBoundingClientRect().y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dataUrl = await imageToDataUrl(img);
      if (dataUrl && !out.includes(dataUrl)) out.push(dataUrl);
    }
  }

  if (out.length > 0) return out;

  const allImgs = collectImagesDeep(document.body);
  for (const img of allImgs) {
    const src = getImgSrc(img);
    if (!src.startsWith('blob:') && !src.startsWith('data:')) continue;
    if (!isLikelyAttachmentImage(img)) continue;
    const dataUrl = await imageToDataUrl(img);
    if (dataUrl && !out.includes(dataUrl)) out.push(dataUrl);
  }

  return out;
}

/**
 * Some previews render as <canvas> instead of <img>.
 */
function collectComposerCanvases() {
  const out = [];
  const roots = [document.querySelector('main'), document.body].filter(Boolean);
  for (const root of roots) {
    walkElementsDeep(root, (el) => {
      if (el.tagName !== 'CANVAS') return;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      if (r.bottom < window.innerHeight * 0.08) return;
      try {
        out.push(el.toDataURL('image/png'));
      } catch (e) {
        /* tainted canvas */
      }
    });
  }
  return out;
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
    const candidates = document.querySelectorAll(selector);
    for (const el of candidates) {
      if (el && (el.innerText.trim() || el.querySelector('img'))) {
        inputArea = el;
        break;
      }
    }
    if (inputArea) break;
  }
  
  if (inputArea) {
    text = inputArea.innerText.trim();
  }
  
  // Attached images near composer (Claude wraps previews in <button> — do not skip large preview buttons)
  const inputContainer =
    inputArea?.closest('form') ||
    document.querySelector('form') ||
    document.querySelector('[class*="composer"]') ||
    document.querySelector('[class*="input-container"]') ||
    document.querySelector('[data-testid*="composer"]') ||
    document.querySelector('main');

  if (inputContainer) {
    const attachedImages = collectImagesDeep(inputContainer);
    for (const img of attachedImages) {
      if (!isLikelyAttachmentImage(img)) continue;

      const dataUrl = await imageToDataUrl(img);
      if (dataUrl && !images.includes(dataUrl)) images.push(dataUrl);
    }
  }

  // Fallback: some Claude layouts render attachment row outside the first container match
  if (images.length === 0) {
    const fallbackRoots = [
      document.querySelector('main'),
      document.body
    ].filter(Boolean);
    for (const root of fallbackRoots) {
      for (const img of collectImagesDeep(root)) {
        const src = getImgSrc(img);
        if (!src.startsWith('blob:') && !src.startsWith('data:')) continue;
        if (!isLikelyAttachmentImage(img)) continue;
        const dataUrl = await imageToDataUrl(img);
        if (dataUrl && !images.includes(dataUrl)) images.push(dataUrl);
      }
      if (images.length > 0) break;
    }
  }

  if (images.length === 0) {
    images = await collectComposerImagesAggressive();
  }

  if (images.length === 0) {
    const canvases = collectComposerCanvases();
    images = canvases.filter(Boolean);
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
      const src = getImgSrc(img);
      if (!src) {
        resolve(null);
        return;
      }
      if (src.startsWith('data:')) {
        resolve(src);
        return;
      }
      
      if (src.startsWith('blob:')) {
        fetch(src)
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
      newImg.src = src;
      
    } catch (error) {
      resolve(null);
    }
  });
}
