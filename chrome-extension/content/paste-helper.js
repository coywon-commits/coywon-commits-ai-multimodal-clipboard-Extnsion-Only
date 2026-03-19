/**
 * AI Clipboard - 공통 붙여넣기 헬퍼
 * 각 AI 사이트의 content script와 함께 로드되어 text/image 주입을 담당한다.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'paste') return;

  pasteToCurrentPage(message.payload || {})
    .then(sendResponse)
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true;
});

async function pasteToCurrentPage(payload) {
  const text = typeof payload.text === 'string' ? payload.text : '';
  const images = Array.isArray(payload.images) ? payload.images : [];

  if (!text && images.length === 0) {
    return { success: false, error: '붙여넣을 데이터가 없습니다.' };
  }

  const textInserted = insertTextToInput(text);
  let uploadedCount = 0;
  let imageWarning = '';

  if (images.length > 0) {
    const uploadResult = await uploadImagesToFileInput(images);
    uploadedCount = uploadResult.uploadedCount;
    imageWarning = uploadResult.warning;
  }

  if (!textInserted && uploadedCount === 0) {
    return {
      success: false,
      error: imageWarning || '입력창/이미지 업로드 영역을 찾지 못했습니다.'
    };
  }

  return {
    success: true,
    textInserted,
    uploadedCount,
    warning: imageWarning
  };
}

function insertTextToInput(text) {
  if (!text) return false;

  const input = findInputElement();
  if (!input) return false;

  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const oldValue = input.value || '';
    const nextValue = oldValue ? `${oldValue}\n${text}` : text;
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (input.isContentEditable) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    const hasContent = (input.innerText || '').trim().length > 0;
    const insertStr = hasContent ? `\n${text}` : text;
    const ok = document.execCommand('insertText', false, insertStr);
    if (ok) return true;

    const current = (input.innerText || '').trim();
    input.innerText = current ? `${current}\n${text}` : text;
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: text,
        inputType: 'insertText'
      })
    );
    return true;
  }

  return false;
}

function findInputElement() {
  if (isGeminiSite()) {
    const richTextarea = document.querySelector('rich-textarea');
    if (richTextarea) {
      const inner =
        richTextarea.querySelector('[contenteditable="true"]') ||
        (richTextarea.shadowRoot ? richTextarea.shadowRoot.querySelector('[contenteditable="true"]') : null);
      if (inner && isElementVisible(inner)) return inner;
    }

    const geminiComposer = document.querySelector(
      '.ql-editor, [contenteditable="true"][aria-label], textarea'
    );
    if (geminiComposer && isElementVisible(geminiComposer)) return geminiComposer;
  }

  const selectors = [
    '#prompt-textarea',
    'textarea',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    '[contenteditable="true"]',
    'input[type="text"]'
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (!isElementVisible(el)) continue;
    return el;
  }

  return null;
}

async function uploadImagesToFileInput(images) {
  const input = await findImageFileInputWithReveal();
  if (input) {
    const direct = uploadImagesByFileInput(images, input);
    if (direct.uploadedCount > 0) return direct;
  }

  // Fallback 1: drop event on active input/editor area.
  const dropFallback = uploadImagesByDropEvent(images);
  if (dropFallback.uploadedCount > 0) return dropFallback;

  // Fallback 2: synthetic paste event.
  const pasteFallback = uploadImagesByPasteEvent(images);
  if (pasteFallback.uploadedCount > 0) return pasteFallback;

  return { uploadedCount: 0, warning: '이미지 업로드 경로를 찾지 못했습니다.' };
}

async function uploadImagesToGeminiByPaste(images) {
  const files = images.map((img, i) => imagePayloadToFile(img, i)).filter(Boolean);
  if (files.length === 0) {
    return { uploadedCount: 0, warning: '이미지 데이터 변환에 실패했습니다.' };
  }

  return new Promise(async (resolve) => {
    let intercepted = false;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener('click', clickBlocker, true);
      observer.disconnect();
    };

    const injectFiles = (input) => {
      if (intercepted || !input) return;
      intercepted = true;

      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);

      Object.defineProperty(input, 'files', {
        value: dt.files,
        writable: false,
        configurable: true
      });

      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      cleanup();
      resolve({ uploadedCount: files.length, warning: '' });
    };

    const clickBlocker = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'file') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      injectFiles(target);
    };
    document.addEventListener('click', clickBlocker, true);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          const candidates =
            node instanceof HTMLInputElement && node.type === 'file'
              ? [node]
              : Array.from(node.querySelectorAll('input[type="file"]'));

          for (const input of candidates) {
            input.addEventListener(
              'click',
              (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                injectFiles(input);
              },
              { capture: true, once: true }
            );
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    await openGeminiUploadMenuAndSelectFileUpload();

    setTimeout(() => {
      cleanup();
      if (!intercepted) {
        resolve({ uploadedCount: 0, warning: 'Gemini 파일 입력창을 찾지 못했습니다.' });
      }
    }, 2000);
  });
}

async function findImageFileInputWithReveal() {
  if (isGeminiSite()) {
    // 0) Prefer hidden Gemini file input already present in DOM.
    let input = document.querySelector(
      '[xapfileselectortrigger] input[type="file"], .hidden-local-file-image-selector-button input[type="file"], input[type="file"]'
    );
    if (input) return input;

    // 1) Open menu button only (do not click "File upload" yet).
    const menuBtn = document.querySelector('button[aria-label="파일 업로드 메뉴 열기"]');
    if (menuBtn && isElementVisible(menuBtn)) {
      menuBtn.click();
      await sleep(420);
    }

    // 2) Re-check hidden input after menu opens.
    input = document.querySelector(
      '[xapfileselectortrigger] input[type="file"], .hidden-local-file-image-selector-button input[type="file"], input[type="file"]'
    );
    if (input) return input;

    // 3) Last resort: intercept file-input click, then click menu item.
    return new Promise((resolve) => {
      const blocker = (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.type !== 'file') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        document.removeEventListener('click', blocker, true);
        resolve(target);
      };

      document.addEventListener('click', blocker, true);
      clickGeminiFileUploadMenuItem();
      setTimeout(() => {
        document.removeEventListener('click', blocker, true);
        resolve(null);
      }, 2000);
    });
  }

  let input = findImageFileInput();
  if (input) return input;

  // Non-Gemini sites only.
  clickPotentialAttachButtons();
  await sleep(380);
  input = findImageFileInput();
  if (input) return input;

  clickPotentialAttachButtons();
  await sleep(380);
  return findImageFileInput();
}

function isGeminiSite() {
  return location.hostname === 'gemini.google.com';
}

async function openGeminiUploadMenuAndSelectFileUpload() {
  const uploadBtn = document.querySelector('button[aria-label="파일 업로드 메뉴 열기"]');
  if (uploadBtn && isElementVisible(uploadBtn)) {
    uploadBtn.click();
    await sleep(420);
  } else {
    const openSelectors = [
      'button[aria-label*="Upload"]',
      'button[aria-label*="upload"]',
      'button[aria-label*="파일"]',
      'button[aria-label*="업로드"]',
      'button[title*="Upload"]',
      'button[title*="upload"]',
      'button[title*="파일"]',
      'button[title*="업로드"]'
    ];
    for (const selector of openSelectors) {
      const button = document.querySelector(selector);
      if (!button || !isElementVisible(button)) continue;
      button.click();
      break;
    }
    await sleep(420);
  }

  clickGeminiFileUploadMenuItem();
  await sleep(420);
}

function findImageFileInput() {
  if (isGeminiSite()) {
    const geminiTrigger = document.querySelector(
      '[xapfileselectortrigger] input[type="file"], .hidden-local-file-image-selector-button input[type="file"], button[xapfileselectortrigger] input[type="file"]'
    );
    if (geminiTrigger) return geminiTrigger;
  }

  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  if (inputs.length === 0) return null;

  const imageInput = inputs.find((el) => {
    const accept = (el.getAttribute('accept') || '').toLowerCase();
    return accept.includes('image') || accept === '';
  });

  return imageInput || inputs[0];
}

function uploadImagesByFileInput(images, input) {
  const dt = new DataTransfer();
  let uploadedCount = 0;

  for (let i = 0; i < images.length; i += 1) {
    const file = dataUrlToFile(images[i], i);
    if (!file) continue;
    dt.items.add(file);
    uploadedCount += 1;
  }

  if (uploadedCount === 0) {
    return { uploadedCount: 0, warning: '이미지 데이터 변환에 실패했습니다.' };
  }

  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { uploadedCount, warning: '' };
}

function uploadImagesByDropEvent(images) {
  const target = findGeminiDropTarget() || findInputElement();
  if (!target) return { uploadedCount: 0, warning: 'drop target not found' };

  const dt = new DataTransfer();
  let uploadedCount = 0;
  for (let i = 0; i < images.length; i += 1) {
    const file = dataUrlToFile(images[i], i);
    if (!file) continue;
    dt.items.add(file);
    uploadedCount += 1;
  }
  if (uploadedCount === 0) return { uploadedCount: 0, warning: 'image conversion failed' };

  target.focus();
  const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  target.dispatchEvent(dropEvent);
  return { uploadedCount, warning: '' };
}

function findGeminiDropTarget() {
  if (!isGeminiSite()) return null;

  const selectors = [
    'rich-textarea',
    '[class*="composer"]',
    '[class*="input"]',
    'main'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el || !isElementVisible(el)) continue;
    return el;
  }
  return null;
}

function clickPotentialAttachButtons() {
  const selectors = [
    'button[aria-label*="Upload"]',
    'button[aria-label*="upload"]',
    'button[aria-label*="image"]',
    'button[aria-label*="Image"]',
    'button[aria-label*="photo"]',
    'button[aria-label*="Photo"]',
    'button[aria-label*="file"]',
    'button[aria-label*="첨부"]',
    'button[aria-label*="업로드"]',
    'button[aria-label*="사진"]',
    'button[title*="Upload"]',
    'button[title*="image"]',
    'button[title*="photo"]',
    'button[title*="첨부"]',
    'button[title*="업로드"]'
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector);
    if (!button || !isElementVisible(button)) continue;
    button.click();
    return;
  }
}

function clickGeminiFileUploadMenuItem() {
  const candidates = Array.from(document.querySelectorAll('[role="menuitem"], button'));

  const target = candidates.find((el) => {
    if (!isElementVisible(el)) return false;
    const text = (el.textContent || '').trim().toLowerCase();
    return (
      text === '파일 업로드' ||
      text.includes('파일 업로드') ||
      text.includes('파일 추가') ||
      text === 'file upload' ||
      text.includes('upload file') ||
      text.includes('add file')
    );
  });

  if (target) {
    target.click();
  }
}

function uploadImagesByPasteEvent(images) {
  const target = findInputElement();
  if (!target) return { uploadedCount: 0, warning: '붙여넣기 대상 입력창을 찾지 못했습니다.' };

  const dt = new DataTransfer();
  let uploadedCount = 0;
  for (let i = 0; i < images.length; i += 1) {
    const file = dataUrlToFile(images[i], i);
    if (!file) continue;
    dt.items.add(file);
    uploadedCount += 1;
  }

  if (uploadedCount === 0) {
    return { uploadedCount: 0, warning: '이미지 데이터 변환에 실패했습니다.' };
  }

  target.focus();
  const evt = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'clipboardData', { value: dt });
  target.dispatchEvent(evt);
  return { uploadedCount, warning: '' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataUrlToFile(dataUrl, index) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;

  const parts = dataUrl.split(',');
  if (parts.length < 2) return null;

  const mimeMatch = parts[0].match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(parts[1]);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const ext = mime.includes('jpeg') ? 'jpg' : 'png';
  return new File([bytes], `ai_clipboard_${String(index + 1).padStart(3, '0')}.${ext}`, { type: mime });
}

function imagePayloadToFile(image, index) {
  if (typeof image === 'string') {
    return dataUrlToFile(image, index);
  }

  if (!image || typeof image !== 'object') return null;
  const base64 = typeof image.base64 === 'string' ? image.base64 : '';
  if (!base64) return null;

  const mime = typeof image.mimeType === 'string' && image.mimeType ? image.mimeType : 'image/png';
  const filename =
    typeof image.filename === 'string' && image.filename
      ? image.filename
      : `ai_clipboard_${String(index + 1).padStart(3, '0')}.png`;

  try {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    return new File([blob], filename, { type: mime });
  } catch (e) {
    return null;
  }
}

function isElementVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

