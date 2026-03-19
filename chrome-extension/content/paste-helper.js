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
    const oldText = input.innerText ? input.innerText.trim() : '';
    const nextText = oldText ? `${oldText}\n${text}` : text;

    input.innerText = nextText;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  return false;
}

function findInputElement() {
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
  const input = findImageFileInput();
  if (!input) {
    return {
      uploadedCount: 0,
      warning: '이미지 업로드 입력(input[type=file])을 찾지 못했습니다.'
    };
  }

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

function findImageFileInput() {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  if (inputs.length === 0) return null;

  const imageInput = inputs.find((el) => {
    const accept = (el.getAttribute('accept') || '').toLowerCase();
    return accept.includes('image') || accept === '';
  });

  return imageInput || inputs[0];
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

function isElementVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

