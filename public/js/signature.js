// Signature image for bills.
//  - signatureFromFile: turns an uploaded image into a small, tightly cropped PNG (data URL) that is stored in
//    the settings, so it syncs to every device. A transparent PNG is kept as it is; a photo or scan on white
//    paper has its white background made transparent.
//  - signatureForPdf: decodes that PNG into the RGB + transparency streams the PDF writer embeds.

const MAX_W = 600, MAX_H = 240, MAX_DATA_URL = 300000;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image could not be read. Use a PNG or JPG file.'));
    img.src = src;
  });
}
function pixelsOf(img, w, h) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx, data: ctx.getImageData(0, 0, w, h) };
}

export async function signatureFromFile(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Choose an image file (a PNG with a transparent background works best).');
  if (file.size > 15 * 1024 * 1024) throw new Error('This image is too large. Use one under 15 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const { canvas, ctx, data } = pixelsOf(img, w, h), d = data.data;

    // No transparent pixels at all → a photo/scan: make the white paper transparent.
    let hasTransparency = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasTransparency = true; break; }
    if (!hasTransparency) {
      for (let i = 0; i < d.length; i += 4) {
        const light = Math.min(d[i], d[i + 1], d[i + 2]);
        d[i + 3] = light >= 215 ? 0 : light >= 170 ? Math.round(255 * (215 - light) / 45) : 255;
      }
      ctx.putImageData(data, 0, 0);
    }

    // Crop to the visible ink.
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) throw new Error('The image looks empty. Upload a picture of the signature.');
    const pad = 4; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;

    for (let fit = 1; fit > 0.2; fit *= 0.7) {
      const s = Math.min(1, MAX_W / cw, MAX_H / ch) * fit;
      const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(cw * s)); out.height = Math.max(1, Math.round(ch * s));
      const octx = out.getContext('2d'); octx.imageSmoothingQuality = 'high';
      octx.drawImage(canvas, x0, y0, cw, ch, 0, 0, out.width, out.height);
      const dataUrl = out.toDataURL('image/png');
      if (dataUrl.length <= MAX_DATA_URL) return dataUrl;
    }
    throw new Error('This signature image is too detailed. Try a simpler or smaller picture.');
  } finally { URL.revokeObjectURL(url); }
}

async function deflate(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')); // zlib format = PDF FlateDecode
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

const cache = new Map();
export function signatureForPdf(dataUrl) {
  if (!dataUrl) return Promise.resolve(null);
  if (!cache.has(dataUrl)) cache.set(dataUrl, decode(dataUrl).catch(() => null));
  return cache.get(dataUrl);
}
async function decode(dataUrl) {
  const img = await loadImage(dataUrl), w = img.naturalWidth, h = img.naturalHeight;
  const d = pixelsOf(img, w, h).data.data, rgb = new Uint8Array(w * h * 3), alpha = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) { rgb[p * 3] = d[i]; rgb[p * 3 + 1] = d[i + 1]; rgb[p * 3 + 2] = d[i + 2]; alpha[p] = d[i + 3]; }
  const [rgbZ, alphaZ] = await Promise.all([deflate(rgb), deflate(alpha)]);
  return rgbZ && alphaZ ? { w, h, rgb: rgbZ, alpha: alphaZ, flate: true } : { w, h, rgb, alpha, flate: false };
}
