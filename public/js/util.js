// Shared helpers: formatting, GST maths, data migration. Used by the screen, the PDF and both storage backends.

export const GST_RATES = [0, 3, 5, 12, 18, 28];
export const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank transfer', 'Credit (pay later)'];
export const ITEM_DEFAULTS = { hsn: '85171300', quantity: 1, taxRate: 18, discount: 0 };
export const BUSINESS_DEFAULTS = {
  businessName: 'MM MOBILES', gstin: '32ABEFM7356G1ZA',
  businessAddress: 'K.P BUILDING, 13/222B, MUTHUR, TIRUR MUNICIPALITY, TIRUR 676101',
  businessPhone: '7012172314, 9846823999', state: 'KERALA', stateCode: '32',
  businessEmail: '', bankDetails: '', terms: 'Goods once sold will not be taken back. Warranty as per manufacturer terms.'
};
export const DEFAULT_SETTINGS = { invoicePrefix: 'MMM-', invoiceStart: 1, invoiceDigits: 5, roundUp: false, ...BUSINESS_DEFAULTS };

/* ---------- Shop profiles. "main" is the GST shop; "second" is an optional second shop that bills without GST.
   Both live in the same synced data: bills and products carry a `profile` field (missing = main). ---------- */
export const SECOND_DEFAULTS = {
  enabled: false, businessName: 'MAX MOBILES', businessAddress: '', businessPhone: '', businessEmail: '', bankDetails: '',
  terms: 'Goods once sold will not be taken back.', invoicePrefix: 'MAX-', invoiceStart: 1, invoiceDigits: 5
};
export function profileOf(record) { return record?.profile === 'second' ? 'second' : 'main'; }
// Settings for one shop, in the same shape as the main settings (so numbering and bill code can use either).
export function profileSettings(settings, profile) {
  const s = settings || cleanSettings();
  if (profile !== 'second') return { ...s, gst: true };
  return { ...(s.second || SECOND_DEFAULTS), gstin: '', state: '', stateCode: '', roundUp: s.roundUp, signature: s.signature, gst: false };
}
export function counterKey(profile, year) { return profile === 'second' ? `second:${year}` : year; }

export const $ = id => document.getElementById(id);
export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}
export function format(value) { return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
export function money(value) { return `₹${format(value)}`; }
export function dateForDisplay(value) { if (!value) return ''; const [y, m, d] = String(value).split('-'); return `${d}/${m}/${y}`; }
export function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function esc(text) { return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function cleanText(value, maximum = 200) { return String(value ?? '').trim().slice(0, maximum); }

export function numberToWords(amount) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const under1000 = n => { let out = ''; if (n >= 100) { out += ones[Math.floor(n / 100)] + ' Hundred '; n %= 100; } if (n >= 20) out += tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''); else out += ones[n]; return out.trim(); };
  const rupees = Math.floor(Math.abs(amount) + 1e-9), paise = Math.round((Math.abs(amount) - rupees) * 100);
  if (!rupees && !paise) return 'Rupees Zero Only';
  const groups = [['Crore', 10000000], ['Lakh', 100000], ['Thousand', 1000]]; let n = rupees, out = '';
  groups.forEach(([label, value]) => { if (n >= value) { out += under1000(Math.floor(n / value)) + ' ' + label + ' '; n %= value; } });
  out = (out + under1000(n)).trim();
  return `Rupees ${out || 'Zero'}${paise ? ` and ${under1000(paise)} Paise` : ''} Only`;
}

export function financialYear(dateValue) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateValue || '') ? new Date(`${dateValue}T12:00:00`) : new Date();
  const startYear = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}
export function formatInvoiceNo(settings, year, counter) {
  const digits = Math.min(9, Math.max(1, Number(settings.invoiceDigits) || 5));
  return `${settings.invoicePrefix ?? 'MMM-'}${year}/${String(counter).padStart(digits, '0')}`;
}
export function counterFromInvoices(invoices, year, settings) {
  const prefix = String(settings.invoicePrefix ?? 'MMM-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${prefix}${year.replace('-', '\\-')}/(\\d+)$`);
  return invoices.reduce((m, i) => Math.max(m, Number((i.invoiceNo || '').match(match)?.[1] || 0)), 0);
}
// Each shop has its own numbering: `settings` is that shop's settings (see profileSettings).
export function nextCounter(counters, invoices, year, settings, profile = 'main') {
  const mine = invoices.filter(i => profileOf(i) === profile);
  return Math.max(Number(counters?.[counterKey(profile, year)]) || 0, counterFromInvoices(mine, year, settings), (Number(settings.invoiceStart) || 1) - 1) + 1;
}

/* ---------- GST maths. Prices are entered GST-inclusive (as the shop sells at MRP). ---------- */
export function calcItem(item, interState = false) {
  const rate = (Number(item.taxRate) || 0) / 100;
  const gross = (Number(item.price) || 0) * (Number(item.quantity) || 0);
  const discount = Math.min(gross, Math.max(0, Number(item.discount) || 0));
  const lineTotal = gross - discount, net = lineTotal / (1 + rate), tax = lineTotal - net;
  return { ...item, gross, discount, net, tax, sgst: interState ? 0 : tax / 2, cgst: interState ? 0 : tax / 2, igst: interState ? tax : 0, lineTotal };
}
export function isInterState(invoice) { return invoice.supplyType === 'inter'; }
export function calcInvoice(invoice, fallbackRoundUp = false) {
  const inter = isInterState(invoice);
  const items = (invoice.items || []).map(i => calcItem(i, inter));
  const sum = k => items.reduce((s, i) => s + i[k], 0);
  const total = sum('lineTotal');
  const roundUp = invoice.roundUp !== undefined ? Boolean(invoice.roundUp) : fallbackRoundUp;
  const grandTotal = roundUp ? Math.round(total) : Math.round(total * 100) / 100;
  const received = invoice.status === 'cancelled' ? 0 : Math.min(grandTotal, Math.max(0, Number(invoice.payment?.received) || 0));
  return {
    items, inter, net: sum('net'), sgst: sum('sgst'), cgst: sum('cgst'), igst: sum('igst'), tax: sum('tax'), discount: sum('discount'),
    qty: items.reduce((s, i) => s + (Number(i.quantity) || 0), 0), total, roundOff: grandTotal - total, grandTotal,
    received, balance: invoice.status === 'cancelled' ? 0 : Math.max(0, grandTotal - received)
  };
}
export function paymentStatus(invoice) {
  if (invoice.status === 'cancelled') return 'cancelled';
  const t = calcInvoice(invoice);
  if (t.balance <= 0.004) return 'paid';
  return t.received > 0 ? 'partial' : 'due';
}

/* ---------- Old data (from earlier versions of this app) gets lifted into the current shape. ---------- */
export function migrateInvoice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let invoice = raw;
  if (!Array.isArray(invoice.items)) {
    const { model, hsn, imei, quantity, price, taxRate, ...rest } = invoice;
    invoice = { ...rest, items: [{ model, hsn: hsn || ITEM_DEFAULTS.hsn, imei: imei || '', quantity: Number(quantity) || 1, price: Number(price) || 0, taxRate: Number(taxRate) || 18 }] };
  }
  const items = invoice.items.map(it => ({
    model: cleanText(it?.model, 150), hsn: cleanText(it?.hsn, 20) || ITEM_DEFAULTS.hsn, imei: cleanText(it?.imei, 20).replace(/\D/g, ''),
    quantity: Math.max(1, Math.min(9999, Number(it?.quantity) || 1)), price: Math.max(0, Number(it?.price) || 0),
    discount: Math.max(0, Number(it?.discount) || 0), taxRate: GST_RATES.includes(Number(it?.taxRate)) ? Number(it.taxRate) : 18
  })).filter(it => it.model);
  if (!items.length || !/^\d{4}-\d{2}-\d{2}$/.test(invoice.date || '')) return null;
  const noGst = Boolean(invoice.noGst);
  if (noGst) items.forEach(it => { it.taxRate = 0; });
  const out = {
    profile: profileOf(invoice), noGst,
    id: cleanText(invoice.id, 40) || `inv_${String(invoice.invoiceNo || uid()).replace(/[^\w-]+/g, '_')}`,
    invoiceNo: cleanText(invoice.invoiceNo, 40) || 'UNKNOWN', date: invoice.date,
    createdAt: cleanText(invoice.createdAt, 40) || new Date().toISOString(), updatedAt: cleanText(invoice.updatedAt, 40) || cleanText(invoice.createdAt, 40) || new Date().toISOString(),
    status: invoice.status === 'cancelled' ? 'cancelled' : 'active',
    customer: {
      name: cleanText(invoice.customer?.name, 100), phone: cleanText(invoice.customer?.phone, 20), address: cleanText(invoice.customer?.address, 300),
      gstin: cleanText(invoice.customer?.gstin, 20).toUpperCase(), state: cleanText(invoice.customer?.state, 50), stateCode: cleanText(invoice.customer?.stateCode, 5)
    },
    items, supplyType: !noGst && invoice.supplyType === 'inter' ? 'inter' : 'intra',
    businessName: cleanText(invoice.businessName, 100) || BUSINESS_DEFAULTS.businessName, gstin: cleanText(invoice.gstin, 30),
    businessAddress: cleanText(invoice.businessAddress, 300), businessPhone: cleanText(invoice.businessPhone, 80),
    state: cleanText(invoice.state, 50), stateCode: cleanText(invoice.stateCode, 10), roundUp: Boolean(invoice.roundUp),
    businessEmail: cleanText(invoice.businessEmail, 120), bankDetails: cleanText(invoice.bankDetails, 400), terms: cleanText(invoice.terms, 400),
    notes: cleanText(invoice.notes, 500), createdBy: cleanText(invoice.createdBy, 120), updatedBy: cleanText(invoice.updatedBy, 120)
  };
  const grand = calcInvoice({ ...out, payment: { received: 0 } }).grandTotal;
  // Bills from older versions had no payment info: they were cash sales, so treat them as fully paid.
  out.payment = invoice.payment && typeof invoice.payment === 'object'
    ? { mode: PAYMENT_MODES.includes(invoice.payment.mode) ? invoice.payment.mode : 'Cash', received: Math.max(0, Number(invoice.payment.received) || 0), reference: cleanText(invoice.payment.reference, 60), history: Array.isArray(invoice.payment.history) ? invoice.payment.history.slice(-50).map(h => ({ date: cleanText(h?.date, 10), amount: Math.max(0, Number(h?.amount) || 0), mode: cleanText(h?.mode, 30) })) : [] }
    : { mode: 'Cash', received: grand, reference: '', history: [] };
  return out;
}
// Dealer price code used in the second shop: a short code for the dealer (cost) price, e.g. "A", "B", "ABC".
// Only for the shop's own use: shown in the product list, billing suggestions and labels, never on bills.
export function cleanProductCode(value) { return cleanText(value, 20).toUpperCase(); }
// Item number = the product's barcode. Unique within a shop. Made automatically (main shop 100001…,
// second shop 200001…) or typed / scanned from the barcode already on the box.
export function cleanItemNo(value) { const v = cleanText(value, 40); return /^[\x21-\x7E]+$/.test(v) ? v : ''; }
export function nextItemNo(products, profile) {
  const lead = profile === 'second' ? '2' : '1', pattern = new RegExp(`^${lead}(\\d{5})$`);
  const used = products.filter(p => profileOf(p) === profile).map(p => Number(p.itemNo?.match(pattern)?.[1] || 0));
  return `${lead}${String(Math.max(0, ...used) + 1).padStart(5, '0')}`;
}
export function cleanProduct(raw) {
  const name = cleanText(raw?.name, 150);
  if (!name) return null;
  return {
    id: cleanText(raw.id, 40) || `prd_${uid()}`, profile: profileOf(raw), name, hsn: cleanText(raw.hsn, 20) || ITEM_DEFAULTS.hsn,
    code: profileOf(raw) === 'second' ? cleanProductCode(raw.code) : '', itemNo: cleanItemNo(raw.itemNo),
    price: Math.max(0, Number(raw.price) || 0), taxRate: GST_RATES.includes(Number(raw.taxRate)) ? Number(raw.taxRate) : 18,
    stock: raw.stock === '' || raw.stock == null ? null : Math.round(Number(raw.stock) || 0), updatedAt: cleanText(raw.updatedAt, 40) || new Date().toISOString()
  };
}
export function cleanSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const out = {
    invoicePrefix: cleanText(s.invoicePrefix, 20) || 'MMM-', invoiceStart: Math.max(1, Math.min(999999999, Math.floor(Number(s.invoiceStart) || 1))),
    invoiceDigits: Math.min(9, Math.max(1, Math.floor(Number(s.invoiceDigits) || 5))), roundUp: Boolean(s.roundUp)
  };
  for (const k of Object.keys(BUSINESS_DEFAULTS)) out[k] = cleanText(s[k], k === 'terms' || k === 'bankDetails' || k === 'businessAddress' ? 400 : 120);
  if (!out.businessName) out.businessName = BUSINESS_DEFAULTS.businessName;
  out.signature = cleanSignature(s.signature);
  out.second = cleanSecondShop(s.second);
  return out;
}
export function cleanSecondShop(raw) {
  const s = { ...SECOND_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    enabled: Boolean(s.enabled), businessName: cleanText(s.businessName, 100) || SECOND_DEFAULTS.businessName,
    businessAddress: cleanText(s.businessAddress, 400), businessPhone: cleanText(s.businessPhone, 120), businessEmail: cleanText(s.businessEmail, 120),
    bankDetails: cleanText(s.bankDetails, 400), terms: cleanText(s.terms, 400),
    invoicePrefix: cleanText(s.invoicePrefix, 20) || SECOND_DEFAULTS.invoicePrefix, invoiceStart: Math.max(1, Math.min(999999999, Math.floor(Number(s.invoiceStart) || 1))),
    invoiceDigits: Math.min(9, Math.max(1, Math.floor(Number(s.invoiceDigits) || 5)))
  };
}
// Signature printed on bills: a PNG data URL made by the Settings screen (kept small so it syncs quickly).
export function cleanSignature(value) {
  return typeof value === 'string' && value.length <= 300000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : '';
}

export function validateInvoice(inv) {
  const errors = [];
  if (!inv.customer.name) errors.push('Customer name is required.');
  if (inv.customer.phone && !/^\+?[0-9][0-9 -]{8,18}$/.test(inv.customer.phone)) errors.push('Enter a valid phone number.');
  if (inv.customer.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(inv.customer.gstin)) errors.push('Customer GSTIN must be 15 characters (e.g. 32ABCDE1234F1Z5).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.date || '')) errors.push('Select an invoice date.');
  if (!inv.items.length) errors.push('Add at least one item.');
  inv.items.forEach((it, i) => {
    if (!it.model) errors.push(`Item ${i + 1}: name is required.`);
    if (it.imei && it.imei.length !== 15) errors.push(`Item ${i + 1}: IMEI must contain 15 digits.`);
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 9999) errors.push(`Item ${i + 1}: quantity must be between 1 and 9999.`);
    if (!(it.price > 0) || it.price > 10000000) errors.push(`Item ${i + 1}: enter a valid ${inv.noGst ? '' : 'GST-inclusive '}price.`);
    if (it.discount < 0 || it.discount > it.price * it.quantity) errors.push(`Item ${i + 1}: discount can't be more than the line amount.`);
  });
  return errors;
}

export function deviceLabel() {
  const ua = navigator.userAgent || '';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Device';
  const kind = /Mobi|Android|iPhone/i.test(ua) ? 'phone' : 'computer';
  const browser = window.Capacitor?.isNativePlatform?.() ? 'app' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} ${kind} (${browser})`;
}
export function getDeviceId() {
  try {
    let id = localStorage.getItem('mm-device-id');
    if (!id) { id = `dev_${uid()}`; localStorage.setItem('mm-device-id', id); }
    return id;
  } catch { return `dev_${uid()}`; }
}
export function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
