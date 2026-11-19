// Code 128 barcodes (the kind every shop scanner reads), made without any library so it works offline.
// encodeCode128('200001') → '1101001110011…' where 1 = black module, 0 = white module.
// Numbers use the compact "C" set (two digits per symbol); anything else uses the "B" set (printable ASCII).

// Bar patterns for symbol values 0–106 (ISO/IEC 15417). Each is 11 modules; the last one (STOP) is 13.
const PATTERNS = ('11011001100 11001101100 11001100110 10010011000 10010001100 10001001100 10011001000 10011000100 10001100100 11001001000 '
  + '11001000100 11000100100 10110011100 10011011100 10011001110 10111001100 10011101100 10011100110 11001110010 11001011100 '
  + '11001001110 11011100100 11001110100 11101101110 11101001100 11100101100 11100100110 11101100100 11100110100 11100110010 '
  + '11011011000 11011000110 11000110110 10100011000 10001011000 10001000110 10110001000 10001101000 10001100010 11010001000 '
  + '11000101000 11000100010 10110111000 10110001110 10001101110 10111011000 10111000110 10001110110 11101110110 11010001110 '
  + '11000101110 11011101000 11011100010 11011101110 11101011000 11101000110 11100010110 11101101000 11101100010 11100011010 '
  + '11101111010 11001000010 11110001010 10100110000 10100001100 10010110000 10010000110 10000101100 10000100110 10110010000 '
  + '10110000100 10011010000 10011000010 10000110100 10000110010 11000010010 11001010000 11110111010 11000010100 10001111010 '
  + '10100111100 10010111100 10010011110 10111100100 10011110100 10011110010 11110100100 11110010100 11110010010 11011011110 '
  + '11011110110 11110110110 10101111000 10100011110 10001011110 10111101000 10111100010 11110101000 11110100010 10111011110 '
  + '10111101110 11101011110 11110101110 11010000100 11010010000 11010011100 1100011101011').split(' ');
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

export function isBarcodeText(text) { return /^[\x20-\x7E]{1,40}$/.test(String(text ?? '')); }

export function encodeCode128(text) {
  text = String(text ?? '');
  if (!isBarcodeText(text)) throw new Error('A barcode can only use letters, numbers and common symbols (up to 40).');
  const values = [];
  const digitsOnly = /^\d+$/.test(text);
  if (digitsOnly && text.length >= 2) {
    // Set C for pairs of digits; an odd last digit is written in set B.
    const even = text.length - (text.length % 2);
    values.push(START_C);
    for (let i = 0; i < even; i += 2) values.push(Number(text.slice(i, i + 2)));
    if (even < text.length) values.push(CODE_B, text.charCodeAt(even) - 32);
  } else {
    values.push(START_B);
    for (const ch of text) values.push(ch.charCodeAt(0) - 32);
  }
  const check = values.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103;
  return [...values, check, STOP].map(v => PATTERNS[v]).join('');
}
// unused but kept for clarity of the format: set C → B switch value
void CODE_C;

// Runs of the same colour: [{ black, start, width }] in modules, for drawing as rectangles.
export function barRuns(bits) {
  const runs = [];
  for (let i = 0; i < bits.length;) {
    let j = i; while (j < bits.length && bits[j] === bits[i]) j++;
    if (bits[i] === '1') runs.push({ start: i, width: j - i });
    i = j;
  }
  return runs;
}

// Inline SVG for previews on screen (width scales with the container).
export function barcodeSvg(text, { height = 50 } = {}) {
  const bits = encodeCode128(text), quiet = 10, total = bits.length + quiet * 2;
  const rects = barRuns(bits).map(r => `<rect x="${r.start + quiet}" y="0" width="${r.width}" height="${height}"/>`).join('');
  return `<svg class="barcode-svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" role="img" aria-label="Barcode ${text.replace(/[<>&"]/g, '')}"><rect width="${total}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
