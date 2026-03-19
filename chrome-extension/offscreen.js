chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action !== 'compress') return;

  compressImages(message.images || [], message.maxSize || 800, message.quality || 0.6)
    .then((compressed) => sendResponse({ success: true, compressed }))
    .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));

  return true;
});

async function compressImages(images, maxSize, quality) {
  const results = [];
  for (const img of images) {
    try {
      results.push(await compressOne(img, maxSize, quality));
    } catch (e) {
      results.push(img);
    }
  }
  return results;
}

function compressOne(base64, maxSize, quality) {
  return new Promise((resolve, reject) => {
    if (typeof base64 !== 'string' || !base64.startsWith('data:')) {
      resolve(base64);
      return;
    }

    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > maxSize || h > maxSize) {
        if (w > h) {
          h = Math.round((h * maxSize) / w);
          w = maxSize;
        } else {
          w = Math.round((w * maxSize) / h);
          h = maxSize;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = base64;
  });
}
