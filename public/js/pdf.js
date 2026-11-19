// Self-contained A4 PDF writer for invoices (no library, works offline). Built-in Helvetica only,
// so text is limited to Latin-1; anything else is shown as "?" rather than breaking the file.
import { calcInvoice, format, dateForDisplay, numberToWords, paymentStatus } from './util.js';
import { encodeCode128, barRuns } from './barcode.js';

const W = 595, H = 842, M = 40, CW = W - M * 2, TOP = H - M, BOTTOM = M;

function columnsFor(invoice, totals) {
  const hasDisc = totals.discount > 0;
  if (invoice.noGst) { // plain bill (second shop): no HSN or tax columns
    const cols = [{ key: 'sl', label: 'Sl', w: 22 }, { key: 'item', label: 'Item', w: 0 }, { key: 'qty', label: 'Qty', w: 40, right: true }, { key: 'rate', label: 'Rate', w: 80, right: true }];
    if (hasDisc) cols.push({ key: 'disc', label: 'Disc', w: 65, right: true });
    cols.push({ key: 'total', label: 'Total', w: 85, right: true });
    cols[1].w = CW - cols.reduce((s, c) => s + c.w, 0);
    let x = M; cols.forEach(c => { c.x = x; x += c.w; });
    return cols;
  }
  const cols = [
    { key: 'sl', label: 'Sl', w: 18 }, { key: 'item', label: 'Item', w: 120 }, { key: 'hsn', label: 'HSN', w: 42 },
    { key: 'qty', label: 'Qty', w: 22, right: true }, { key: 'rate', label: 'Rate', w: 52, right: true }
  ];
  if (hasDisc) cols.push({ key: 'disc', label: 'Disc', w: 40, right: true });
  cols.push({ key: 'taxp', label: 'GST%', w: 26, right: true }, { key: 'net', label: 'Taxable', w: 56, right: true });
  if (totals.inter) cols.push({ key: 'igst', label: 'IGST', w: 82, right: true });
  else cols.push({ key: 'cgst', label: 'CGST', w: 41, right: true }, { key: 'sgst', label: 'SGST', w: 41, right: true });
  cols.push({ key: 'total', label: 'Total', w: 53, right: true });
  const used = cols.reduce((s, c) => s + c.w, 0); cols[1].w += CW - used; // give any spare width to the item name
  let x = M; cols.forEach(c => { c.x = x; x += c.w; });
  return cols;
}

const toWinAnsi = t => String(t ?? '').replace(/₹/g, 'Rs.').normalize('NFKD').replace(/[^\x00-\xFF]/g, '?');
const pdfEscape = s => toWinAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const approxWidth = (t, size, f = 0.5) => toWinAnsi(t).length * size * f;
function wrap(text, size, maxWidth, f = 0.5) {
  const lines = [];
  for (const para of toWinAnsi(text).split(/\n/)) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) { const c = line ? `${line} ${w}` : w; if (approxWidth(c, size, f) > maxWidth && line) { lines.push(line); line = w; } else line = c; }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

class Pages {
  constructor() { this.pages = [{ ops: [], y: TOP }]; }
  get p() { return this.pages[this.pages.length - 1]; }
  text(t, x, y, size = 9, bold = false) { if (t === '' || t == null) return; this.p.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfEscape(t)}) Tj ET`); }
  right(t, rx, y, size = 9, bold = false) { this.text(t, rx - approxWidth(t, size, bold ? 0.63 : 0.55), y, size, bold); }
  center(t, cx, y, size = 9, bold = false) { this.text(t, cx - approxWidth(t, size, bold ? 0.56 : 0.5) / 2, y, size, bold); }
  line(x1, y1, x2, y2, w = 0.75) { this.p.ops.push(`${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
  fill(x, y, w, h, grey = 0.93) { this.p.ops.push(`q ${grey} g ${x} ${y} ${w} ${h} re f Q`); }
  ensure(h, onNew) { if (this.p.y - h < BOTTOM) { this.pages.push({ ops: [], y: TOP }); onNew?.(); return true; } return false; }
}

function letterhead(ps, inv, totals) {
  const cx = W / 2;
  ps.center(inv.businessName, cx, ps.p.y, 17, true); ps.p.y -= 17;
  for (const l of wrap(inv.businessAddress, 9, CW * 0.85)) { ps.center(l, cx, ps.p.y, 9); ps.p.y -= 11; }
  const contact = [inv.businessPhone && `Ph: ${inv.businessPhone}`, inv.businessEmail && `Email: ${inv.businessEmail}`].filter(Boolean).join('   ');
  if (contact) { ps.center(contact, cx, ps.p.y, 9); ps.p.y -= 12; }
  ps.p.y -= 2; ps.line(M, ps.p.y, M + CW, ps.p.y, 1.1); ps.p.y -= 18;
  const title = inv.noGst ? 'INVOICE' : 'TAX INVOICE';
  ps.center(inv.status === 'cancelled' ? `${title}  (CANCELLED)` : title, cx, ps.p.y, 13, true); ps.p.y -= 12;
  if (inv.noGst) ps.p.y -= 2;
  else {
    ps.center('Original for Recipient', cx, ps.p.y, 8); ps.p.y -= 16;
    ps.text(`GSTIN: ${inv.gstin}`, M, ps.p.y, 8.5, true);
    ps.right(`State: ${inv.state}   Code: ${inv.stateCode}`, M + CW, ps.p.y, 8.5); ps.p.y -= 8;
  }
  ps.line(M, ps.p.y, M + CW, ps.p.y, 0.6); ps.p.y -= 14;
  ps.text(`Invoice No: ${inv.invoiceNo}`, M, ps.p.y, 9.5, true); ps.right(`Date: ${dateForDisplay(inv.date)}`, M + CW, ps.p.y, 9.5, true); ps.p.y -= 13;
  if (!inv.noGst) ps.text(`Place of supply: ${totals.inter ? `${inv.customer.state || 'Other state'}${inv.customer.stateCode ? ` (${inv.customer.stateCode})` : ''}` : `${inv.state} (${inv.stateCode})`}`, M, ps.p.y, 8.5);
  ps.right(`Payment: ${inv.payment?.mode || 'Cash'}`, M + CW, ps.p.y, 8.5); ps.p.y -= 8;
  ps.line(M, ps.p.y, M + CW, ps.p.y, 0.6); ps.p.y -= 13;
  ps.text('Bill to:', M, ps.p.y, 8, true); ps.p.y -= 12;
  ps.text(inv.customer?.name || '', M, ps.p.y, 10, true); ps.p.y -= 12;
  const extra = [];
  if (inv.customer?.address) extra.push(inv.customer.address);
  if (inv.customer?.phone) extra.push(`Mobile: ${inv.customer.phone}`);
  if (inv.customer?.gstin) extra.push(`GSTIN: ${inv.customer.gstin}`);
  for (const line of extra) for (const w of wrap(line, 8.5, CW)) { ps.text(w, M, ps.p.y, 8.5); ps.p.y -= 11; }
  ps.p.y -= 4;
}
function tableHeader(ps, cols) {
  ps.fill(M, ps.p.y - 6, CW, 18); ps.line(M, ps.p.y + 12, M + CW, ps.p.y + 12, 0.8);
  for (const c of cols) c.right ? ps.right(c.label, c.x + c.w - 2, ps.p.y, 8, true) : ps.text(c.label, c.x + 2, ps.p.y, 8, true);
  ps.p.y -= 6; ps.line(M, ps.p.y, M + CW, ps.p.y, 0.8); ps.p.y -= 12;
}
function itemRow(ps, cols, it, sl) {
  const itemCol = cols[1], lines = wrap(it.model, 8, itemCol.w - 4), sub = it.imei ? [`IMEI: ${it.imei}`] : [];
  const h = Math.max(15, lines.length * 10 + sub.length * 9 + 5);
  ps.ensure(h, () => tableHeader(ps, cols));
  const y = ps.p.y, v = {
    sl: String(sl), hsn: it.hsn, qty: String(it.quantity), rate: format(it.price), disc: format(it.discount), taxp: `${it.taxRate}%`,
    net: format(it.net), cgst: format(it.cgst), sgst: format(it.sgst), igst: format(it.igst), total: format(it.lineTotal)
  };
  for (const c of cols) {
    if (c.key === 'item') { lines.forEach((l, i) => ps.text(l, c.x + 2, y - i * 10, 8)); sub.forEach((l, i) => ps.text(l, c.x + 2, y - lines.length * 10 - i * 9, 7)); continue; }
    c.right ? ps.right(v[c.key], c.x + c.w - 2, y, 8, c.key === 'total') : ps.text(v[c.key], c.x + 2, y, 8);
  }
  ps.p.y -= h; ps.line(M, ps.p.y + 9, M + CW, ps.p.y + 9, 0.2);
}

// options.signature: from signatureForPdf() in signature.js ({ w, h, rgb, alpha, flate }), or null.
export function makeInvoicePdf(inv, { signature = null } = {}) {
  const totals = calcInvoice(inv), cols = columnsFor(inv, totals), ps = new Pages();
  letterhead(ps, inv, totals); tableHeader(ps, cols);
  totals.items.forEach((it, i) => itemRow(ps, cols, it, i + 1));
  ps.line(M, ps.p.y + 8, M + CW, ps.p.y + 8, 0.8); ps.p.y -= 6;

  // GST summary by rate (left) and totals (right)
  const rates = {};
  totals.items.forEach(it => { const r = rates[it.taxRate] ||= { net: 0, tax: 0 }; r.net += it.net; r.tax += it.tax; });
  const summaryRows = inv.noGst ? 0 : Object.keys(rates).length;
  ps.ensure(150 + summaryRows * 11);
  const top = ps.p.y, boxR = M + CW, boxL = boxR - 200;
  let ly = top;
  if (!inv.noGst) {
    ps.text('GST summary', M, top, 8, true);
    ly = top - 12;
    ps.text('Rate', M, ly, 7.5, true); ps.right('Taxable', M + 110, ly, 7.5, true);
    if (totals.inter) ps.right('IGST', M + 170, ly, 7.5, true); else { ps.right('CGST', M + 160, ly, 7.5, true); ps.right('SGST', M + 210, ly, 7.5, true); }
    ly -= 11;
    for (const [rate, r] of Object.entries(rates)) {
      ps.text(`${rate}%`, M, ly, 7.5); ps.right(format(r.net), M + 110, ly, 7.5);
      if (totals.inter) ps.right(format(r.tax), M + 170, ly, 7.5); else { ps.right(format(r.tax / 2), M + 160, ly, 7.5); ps.right(format(r.tax / 2), M + 210, ly, 7.5); }
      ly -= 11;
    }
  }
  let ry = top;
  const rows = [];
  if (inv.noGst) { if (totals.discount > 0) rows.push(['Amount', totals.total + totals.discount], ['Less discount', -totals.discount]); }
  else {
    rows.push(['Taxable amount', totals.net]);
    if (totals.inter) rows.push(['IGST', totals.igst]); else rows.push(['CGST', totals.cgst], ['SGST', totals.sgst]);
    if (totals.discount > 0) rows.push(['Discount given', totals.discount]);
  }
  if (Math.abs(totals.roundOff) > 0.004) rows.push(['Round off', totals.roundOff]);
  for (const [label, val] of rows) { ps.text(label, boxL, ry, 9); ps.right(`${val < 0 ? '-' : ''}${format(Math.abs(val))}`, boxR, ry, 9); ry -= 13; }
  ps.line(boxL, ry + 6, boxR, ry + 6, 0.7); ry -= 8;
  ps.text('Grand Total', boxL, ry, 12, true); ps.right(`Rs. ${format(totals.grandTotal)}`, boxR, ry, 12, true); ry -= 15;
  const status = paymentStatus(inv);
  if (status !== 'cancelled') {
    ps.text('Received', boxL, ry, 8.5); ps.right(format(totals.received), boxR, ry, 8.5); ry -= 11;
    if (totals.balance > 0.004) { ps.text('Balance due', boxL, ry, 8.5, true); ps.right(format(totals.balance), boxR, ry, 8.5, true); ry -= 11; }
  }
  ps.p.y = Math.min(ly, ry) - 10;
  for (const l of wrap(numberToWords(totals.grandTotal), 9, CW)) { ps.text(l, M, ps.p.y, 9, true); ps.p.y -= 12; }
  if (inv.notes) { ps.p.y -= 2; for (const l of wrap(`Note: ${inv.notes}`, 8, CW)) { ps.text(l, M, ps.p.y, 8); ps.p.y -= 10; } }
  if (inv.bankDetails) { ps.p.y -= 2; for (const l of wrap(`Bank: ${inv.bankDetails}`, 8, CW)) { ps.text(l, M, ps.p.y, 8); ps.p.y -= 10; } }
  const signSpace = signature ? 32 : 0; // extra height for the signature image
  ps.p.y -= 6; ps.ensure(80 + signSpace);
  ps.line(M, ps.p.y + 4, M + CW, ps.p.y + 4, 0.6); ps.p.y -= 8;
  const terms = [inv.terms, 'Certified that the particulars given above are true and correct.'].filter(Boolean).join(' ');
  for (const l of wrap(terms, 7, CW * 0.6)) { ps.text(l, M, ps.p.y, 7); ps.p.y -= 9; }
  const signY = Math.max(BOTTOM + 10, ps.p.y - 24 - signSpace);
  ps.right(`For ${inv.businessName}`, M + CW, signY + 40 + signSpace, 9, true);
  if (signature) {
    // Fit inside 160 x 52 pt between "For …" and "Authorised Signatory", right-aligned, sitting on the label.
    const scale = Math.min(160 / signature.w, 52 / signature.h), w = signature.w * scale, h = signature.h * scale;
    ps.p.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${(M + CW - w).toFixed(2)} ${(signY + 11).toFixed(2)} cm /Sig Do Q`);
  }
  ps.right('Authorised Signatory', M + CW, signY, 8);
  ps.pages.forEach((pg, i) => { if (ps.pages.length > 1) pg.ops.push(`BT /F1 7 Tf 1 0 0 1 ${W / 2 - 15} 22 Tm (Page ${i + 1} of ${ps.pages.length}) Tj ET`); });
  return buildPdf(ps.pages, signature);
}

/* ---------- Barcode labels: A4 sheet of 24 (3 × 8, 63.5 × 33.9 mm, the common sticker sheet size) ---------- */
const MM = 72 / 25.4;
const fitText = (t, size, maxW, f) => {
  t = toWinAnsi(t); if (approxWidth(t, size, f) <= maxW) return t;
  while (t.length > 1 && approxWidth(`${t}...`, size, f) > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
};
// labels: [{ shop, name, itemNo, price, code }]. skip: labels already used on the first sheet.
export function makeLabelsPdf(labels, { skip = 0 } = {}) {
  const cols = 3, rows = 8, perPage = cols * rows, lw = 63.5 * MM, lh = 33.9 * MM, pitchX = 66.04 * MM;
  const left = (W - (pitchX * (cols - 1) + lw)) / 2, top = (H - lh * rows) / 2;
  const ps = new Pages(); ps.pages = [{ ops: [], y: 0 }];
  let slot = Math.max(0, Math.min(perPage - 1, Math.floor(skip) || 0));
  for (const label of labels) {
    if (slot === perPage) { ps.pages.push({ ops: [], y: 0 }); slot = 0; }
    const x = left + (slot % cols) * pitchX, y = H - top - (Math.floor(slot / cols) + 1) * lh;
    drawLabel(ps, label, x, y, lw, lh); slot++;
  }
  return buildPdf(ps.pages);
}
function drawLabel(ps, l, x, y, w, h) {
  const pad = 7, inner = w - pad * 2;
  ps.p.ops.push(`q 0.82 G 0.4 w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S Q`); // cutting guide
  ps.text(fitText(l.shop, 6.5, inner - (l.code ? 45 : 0), 0.62), x + pad, y + h - 12, 6.5, true);
  if (l.code) ps.right(fitText(l.code, 7.5, 40, 0.63), x + w - pad, y + h - 12, 7.5, true);
  ps.text(fitText(l.name, 8.5, inner, 0.6), x + pad, y + h - 24, 8.5, true);
  // Bars: at least 10 modules of white each side (quiet zone) so scanners read it; modules at most 1.5 pt wide.
  const bits = encodeCode128(l.itemNo), quiet = 10, modules = bits.length + quiet * 2;
  const mw = Math.min(1.5, inner / modules), bx = x + (w - modules * mw) / 2 + quiet * mw, by = y + 19, bh = h - 24 - 19 - 8;
  for (const run of barRuns(bits)) ps.fill((bx + run.start * mw).toFixed(3), by.toFixed(2), (run.width * mw).toFixed(3), bh.toFixed(2), 0);
  ps.text(l.itemNo, x + pad, y + 8, 8);
  if (l.price > 0) ps.right(`Rs. ${format(l.price)}`, x + w - pad, y + 8, 9.5, true);
}

// Bytes → a string of Latin-1 characters, so binary image data can sit inside the PDF string (one char = one byte).
function binary(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return s; }

function buildPdf(pages, image = null) {
  const objs = [], n = pages.length, boldNum = 4 + n * 2, imgNum = boldNum + 1, maskNum = boldNum + 2;
  const xobjects = image ? ` /XObject << /Sig ${imgNum} 0 R >>` : '';
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[boldNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((pg, i) => {
    const content = pg.ops.join('\n');
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 ${boldNum} 0 R >>${xobjects} >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  if (image) {
    const filter = image.flate ? ' /Filter /FlateDecode' : '', head = `/Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /BitsPerComponent 8${filter}`;
    objs[imgNum] = `<< ${head} /ColorSpace /DeviceRGB /SMask ${maskNum} 0 R /Length ${image.rgb.length} >>\nstream\n${binary(image.rgb)}\nendstream`;
    objs[maskNum] = `<< ${head} /ColorSpace /DeviceGray /Length ${image.alpha.length} >>\nstream\n${binary(image.alpha)}\nendstream`;
  }
  let pdf = '%PDF-1.4\n'; const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(pdf.length); for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xFF;
  return bytes;
}
export function bytesToBase64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

// Opens/shares the PDF: native share sheet in the Android app, download/new tab in a browser.
export async function saveFile(bytes, filename, mime) {
  const fsPlugin = window.Capacitor?.Plugins?.Filesystem, opener = window.Capacitor?.Plugins?.FileOpener;
  if (window.Capacitor?.isNativePlatform?.() && fsPlugin && opener) {
    const saved = await fsPlugin.writeFile({ path: filename, data: bytesToBase64(bytes), directory: 'CACHE', recursive: true });
    await opener.open({ filePath: saved.uri, contentType: mime, openWithDefault: false });
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime })), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function invoiceFilename(inv) { return `${String(inv.invoiceNo || 'invoice').replace(/[^\w.-]+/g, '_')}.pdf`; }
