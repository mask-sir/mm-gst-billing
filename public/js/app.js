import {
  $, esc, format, money, dateForDisplay, today, numberToWords, calcInvoice, paymentStatus, validateInvoice, cleanText, cleanProduct,
  cleanSettings, migrateInvoice, financialYear, formatInvoiceNo, nextCounter, GST_RATES, PAYMENT_MODES, ITEM_DEFAULTS, BUSINESS_DEFAULTS, csvCell, uid,
  profileOf, profileSettings, cleanItemNo, nextItemNo, calcItem, FINANCE_TEMPLATE, NARRATION_MAX, financeNarration, financeValues, swapFigures, paymentLabel, ordinal, cleanFinances, MAX_FINANCES
} from './util.js';
import { barcodeSvg, isBarcodeText } from './barcode.js';
import { LocalStore } from './store-local.js';
import { Cloud, CloudStore, MAX_DEVICES, MAX_STAFF, friendlyError } from './cloud.js';
import { makeInvoicePdf, makeLabelsPdf, saveFile, invoiceFilename } from './pdf.js';
import { signatureFromFile, signatureForPdf } from './signature.js';
import { icon, fillIcons } from './icons.js';
import { APP_VERSION } from './version.js';
import { findUpdate, downloadAndInstall, openInstaller, removeDownloadedApk, plainNotes, isNativeApp, RELEASES_PAGE } from './update.js';

/* =========================================================================
   Storage: `store` is either the local store (signed out) or the cloud store (signed in).
   ========================================================================= */
const localStore = new LocalStore({}, kind => { if (store === localStore) onData(kind); });
let store = localStore, cloud = null, cloudStore = null, shop = null, syncState = 'local';
const S = () => store.state;

let editing = null;          // the saved invoice currently open in the form (null = new bill)
let receivedTouched = false; // has the user typed an amount received by hand?
let currentView = 'dashboard';

/* ---------- Shop profiles: the main GST shop, and an optional second shop without GST.
   The chosen shop is remembered per device; every screen shows only that shop's bills and products. ---------- */
let chosenProfile = 'main';
try { chosenProfile = localStorage.getItem('mm-profile') === 'second' ? 'second' : 'main'; } catch { /* ignore */ }
const secondEnabled = () => Boolean(S().settings?.second?.enabled);
const activeProfile = () => (secondEnabled() ? chosenProfile : 'main');
const P = () => profileSettings(S().settings, activeProfile());          // settings of the shop being used
const formProfile = () => (editing ? profileOf(editing) : activeProfile()); // shop of the bill in the form
const ofActive = record => profileOf(record) === activeProfile();
const myInvoices = () => S().invoices.filter(ofActive);
const myProducts = () => S().products.filter(ofActive);

fillIcons();
const isPhone = () => window.matchMedia('(max-width: 899px)').matches;
const initials = name => (String(name).match(/\b[A-Za-z0-9]/g) || ['?']).slice(0, 2).join('').toUpperCase();
const SHOP_COLORS = { main: '#0a6f65', second: '#4338ca' };
function applyProfileUI() {
  const p = P(), second = secondEnabled();
  document.body.classList.toggle('no-gst', !p.gst);
  document.body.classList.toggle('profile-second', activeProfile() === 'second');
  $('brandName').textContent = p.businessName; $('brandSub').textContent = p.gst ? 'GST billing' : 'Billing';
  $('brandLogo').textContent = initials(p.businessName);
  document.title = `${p.businessName} - ${p.gst ? 'GST ' : ''}Billing`;
  // The shop name at the top left is the shop switch (only when a second shop is set up).
  $('brandBtn').classList.toggle('switchable', second); $('brandCaret').hidden = !second;
  $('brandBtn').title = second ? 'Switch shop' : '';
  $('productSearch').placeholder = p.gst ? 'Search name or item no. (or scan)' : 'Search name, item no. or code (or scan)';
  if (!second) openShopMenu(false); else if (!$('shopMenu').hidden) renderShopMenu();
}
function renderShopMenu() {
  const s = S().settings, active = activeProfile();
  const shops = [['main', s.businessName, 'GST billing'], ['second', s.second.businessName, 'Billing without GST']];
  $('shopMenu').innerHTML = `<div class="shop-menu-title">Switch shop</div>${shops.map(([id, name, sub]) =>
    `<button type="button" role="menuitemradio" aria-checked="${id === active}" data-profile="${id}"><span class="shop-dot" style="background:${SHOP_COLORS[id]}">${esc(initials(name))}</span><span>${esc(name)}<small>${sub}</small></span>${id === active ? '<span class="tick" aria-hidden="true">✓</span>' : ''}</button>`).join('')}
    <button type="button" role="menuitem" class="menu-link" data-shop-settings>Shop settings</button>`;
}
function openShopMenu(open) {
  $('shopMenu').hidden = !open; $('brandBtn').setAttribute('aria-expanded', String(open));
  if (open) { renderShopMenu(); $('shopMenu').querySelector('[aria-checked="true"]')?.focus(); }
}
$('brandBtn').addEventListener('click', () => { if (secondEnabled()) openShopMenu($('shopMenu').hidden); });
document.addEventListener('click', e => { if (!$('shopMenu').hidden && !e.target.closest('.brand-wrap')) openShopMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('shopMenu').hidden) { openShopMenu(false); $('brandBtn').focus(); } });
$('shopMenu').addEventListener('click', async e => {
  if (e.target.closest('[data-shop-settings]')) { openShopMenu(false); showSettings('second'); return; }
  const id = e.target.closest('[data-profile]')?.dataset.profile; if (!id) return;
  openShopMenu(false);
  if (id === activeProfile()) return;
  if (formDirty && !(await confirmBox('Switch shop?', 'This bill is not saved. Changes on the form will be lost.', 'Switch shop'))) return;
  chosenProfile = id; try { localStorage.setItem('mm-profile', id); } catch { /* ignore */ }
  editing = null; resetProductForm(); applyProfileUI(); newInvoice(); renderView();
  toast(`Now billing as ${P().businessName}.`);
});

function onData(kind) {
  if (kind === 'settings' || kind === 'all') {
    applyProfileUI(); fillSettingsForm(); renderFinanceOptions();
    if (editing && profileOf(editing) !== activeProfile()) newInvoice(); // second shop was switched off while one of its bills was open
    renderPreview(); if (!editing) refreshInvoiceNo();
  }
  if (editing && (kind === 'invoices' || kind === 'all')) {
    const fresh = S().invoices.find(i => i.id === editing.id);
    if (fresh && fresh.updatedAt !== editing.updatedAt && !formDirty) { editing = fresh; setForm(fresh); }
  }
  if (!editing && (kind === 'invoices' || kind === 'all')) refreshInvoiceNo();
  renderView();
}

/* ---------- toast + dialog helpers ---------- */
let toastTimer;
function toast(message, type = 'ok') { const t = $('toast'); t.textContent = message; t.dataset.type = type; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, type === 'error' ? 7000 : 3500); }
function dialog(html, onSetup) {
  return new Promise(resolve => {
    const d = $('dialog'); $('dialogBody').innerHTML = html;
    const done = value => { d.close(); resolve(value); };
    $('dialogBody').querySelectorAll('[data-result]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); done(b.dataset.result); }));
    onSetup?.($('dialogBody'), done);
    d.onclose = () => resolve(null);
    d.showModal();
  });
}
async function confirmBox(title, text, ok = 'OK', danger = false) {
  return (await dialog(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="actions end"><button class="secondary" data-result="no">Cancel</button><button class="${danger ? 'danger' : ''}" data-result="yes">${esc(ok)}</button></div>`)) === 'yes';
}

/* =========================================================================
   Navigation
   ========================================================================= */
// Views: dashboard (Home), billing (New sale), bills, customers, products (Items), reports, settings, and menu (phone).
// On a phone, Customers, Reports and Settings live under Menu in the bottom bar.
const MENU_VIEWS = ['customers', 'reports', 'settings', 'menu'];
function show(view) {
  currentView = view;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view || (b.dataset.view === 'menu' && MENU_VIEWS.includes(view))));
  document.querySelectorAll('main > .view').forEach(v => { v.hidden = v.dataset.view !== view; });
  [...document.body.classList].filter(c => c.startsWith('view-')).forEach(c => document.body.classList.remove(c));
  document.body.classList.add(`view-${view}`);
  if (view === 'billing') { setBillingPane('form'); if (!editing && !formDirty) refreshInvoiceNo(); }
  closeTools();
  renderView();
  window.scrollTo({ top: 0 });
}
// "New sale" starts a fresh bill if a saved bill is open; an unsaved new bill is kept.
document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => { if (b.hasAttribute('data-new-sale') && editing) newInvoice(); show(b.dataset.view); }));
document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) { if (go.dataset.go === 'billing' && editing) newInvoice(); show(go.dataset.go); return; }
  const quick = e.target.closest('[data-quick]')?.dataset.quick;
  if (quick === 'collect') { setBillFilter('open'); $('billSearch').value = ''; show('bills'); }
  if (quick === 'add-item') { show('products'); openProductDialog(); }
  if (quick === 'labels') { show('products'); if (myProducts().length) $('printLabels').click(); else toast('Add items first, then print their labels.'); }
  const section = e.target.closest('[data-settings]')?.dataset.settings;
  if (section) showSettings(section);
});
function renderView() {
  ({ dashboard: renderDashboard, billing: renderPreview, bills: renderBills, customers: renderCustomers, products: renderProducts, reports: renderReports, settings: renderSettings, menu: renderAppPanel })[currentView]?.();
}
// Search box in the top bar (computer): searches bills.
$('globalSearch').addEventListener('input', () => {
  $('billSearch').value = $('globalSearch').value; setBillFilter(''); billLimit = 100;
  if (currentView !== 'bills') show('bills'); else renderBills();
});

/* ---------- New sale: Details / Preview tabs (phone + small screens) and the actions menu in the save bar ---------- */
function setBillingPane(pane) {
  $('billingGrid').dataset.pane = pane;
  $('billingTabs').querySelectorAll('[data-pane]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.pane === pane)));
}
$('billingTabs').addEventListener('click', e => { const pane = e.target.closest('[data-pane]')?.dataset.pane; if (pane) { setBillingPane(pane); window.scrollTo({ top: 0 }); } });
function closeTools() { $('billTools').classList.remove('open'); $('toolsToggle').setAttribute('aria-expanded', 'false'); }
$('toolsToggle').addEventListener('click', e => {
  e.stopPropagation();
  const open = !$('billTools').classList.contains('open');
  $('billTools').classList.toggle('open', open); $('toolsToggle').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!e.target.closest('#toolsToggle')) closeTools(); });

/* =========================================================================
   Billing form
   ========================================================================= */
let formDirty = false;
$('paymentMode').innerHTML = PAYMENT_MODES.map(m => `<option>${m}</option>`).join('');
$('pTax').innerHTML = GST_RATES.map(r => `<option value="${r}" ${r === 18 ? 'selected' : ''}>${r}%</option>`).join('');

function createItemRow(item = {}) {
  const row = document.createElement('div'); row.className = 'item-row';
  const tax = Number(item.taxRate ?? ITEM_DEFAULTS.taxRate);
  row.innerHTML = `
    <div class="it-top"><span class="it-no"></span><label class="ac">Item<input class="it-model" maxlength="150" placeholder="${P().gst ? 'e.g. Y11 5G 4+64 SUNRISE' : 'Type a code (e.g. A) or item name'}" value="${esc(item.model || '')}"><div class="ac-list" hidden></div></label></div>
    <div class="it-grid">
      <label>Qty<input class="it-qty" type="number" min="1" max="9999" inputmode="numeric" value="${item.quantity || 1}"></label>
      <label><span>Price<span class="gst-only"> incl. GST</span></span><input class="it-price" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${item.price ?? ''}"></label>
      <label>Discount ₹<input class="it-disc" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" value="${item.discount || ''}"></label>
      <label class="gst-only">GST<select class="it-tax">${GST_RATES.map(r => `<option value="${r}" ${r === tax ? 'selected' : ''}>${r}%</option>`).join('')}</select></label>
      <label class="it-imei-l">IMEI / serial<input class="it-imei" inputmode="numeric" maxlength="15" placeholder="15 digits" value="${esc(item.imei || '')}"></label>
      <label class="gst-only">HSN<input class="it-hsn" maxlength="20" value="${esc(item.hsn ?? ITEM_DEFAULTS.hsn)}"></label>
    </div>
    <div class="it-foot">Amount <span class="it-total"></span></div>
    <button type="button" class="remove-item" aria-label="Remove item" title="Remove item">${icon('trash', 17)}</button>`;
  row.querySelector('.remove-item').addEventListener('click', () => { row.remove(); updateRemoveButtons(); changed(); });
  wireProductAutocomplete(row);
  return row;
}
function updateRemoveButtons() { const rows = [...$('itemRows').children]; rows.forEach(r => { r.querySelector('.remove-item').disabled = rows.length <= 1; }); }
// Row numbers, each row's amount, and the item count.
function updateItemRowsUI() {
  const rows = [...$('itemRows').children];
  rows.forEach((r, i) => {
    r.querySelector('.it-no').textContent = i + 1;
    const line = calcItem({ price: Number(r.querySelector('.it-price').value) || 0, quantity: Math.floor(Number(r.querySelector('.it-qty').value) || 0), discount: Number(r.querySelector('.it-disc').value) || 0, taxRate: 0 });
    r.querySelector('.it-total').textContent = money(line.lineTotal);
  });
  const named = rows.filter(r => r.querySelector('.it-model').value.trim()).length;
  $('itemCount').textContent = named ? `${named} item${named === 1 ? '' : 's'}` : '';
}
function readItems(noGst = false) {
  return [...$('itemRows').children].map(r => ({
    model: cleanText(r.querySelector('.it-model').value, 150), hsn: cleanText(r.querySelector('.it-hsn').value, 20) || ITEM_DEFAULTS.hsn,
    imei: r.querySelector('.it-imei').value.replace(/\D/g, ''), quantity: Math.floor(Number(r.querySelector('.it-qty').value) || 0),
    price: Number(r.querySelector('.it-price').value) || 0, discount: Number(r.querySelector('.it-disc').value) || 0, taxRate: noGst ? 0 : Number(r.querySelector('.it-tax').value)
  })).filter((it, i, all) => it.model || it.price || all.length === 1);
}
/* ---------- Finance (EMI): the finance company pays `finance.amount`, the customer pays the down payment ---------- */
let financeTouched = false; // has the user typed a finance amount by hand?
let autoNarration = '';     // the end part of the narration that was filled in from a finance template
let narrationFigures = null; // the bill's figures (EMI date, amounts) when the narration was last brought up to date
$('emiDay').innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${ordinal(i + 1)} of every month</option>`).join('');
const financeList = () => S().settings?.finances || [];
function renderFinanceOptions(selected = $('financeCo').value, savedName = $('financeCo').selectedOptions?.[0]?.textContent || '') {
  const list = financeList(), extra = selected && !list.some(f => f.id === selected) ? [{ id: selected, name: savedName || selected }] : [];
  $('financeCo').innerHTML = `<option value="">No finance (paid by customer)</option>${[...list, ...extra].map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}`;
  $('financeCo').value = selected || '';
}
function financeFromForm() {
  const id = $('financeCo').value; if (!id) return null;
  // A saved bill keeps the company name it was made with, even if the company is renamed later in Settings.
  const name = editing?.finance && (editing.finance.id || 'saved') === id ? editing.finance.name : financeList().find(f => f.id === id)?.name || $('financeCo').selectedOptions[0]?.textContent || '';
  return { id: editing?.finance && id === 'saved' ? editing.finance.id : id, name, emiDay: Number($('emiDay').value) || 3 };
}
function toggleFinance() {
  const on = Boolean($('financeCo').value);
  document.querySelectorAll('.fin-only').forEach(el => { el.hidden = !on; });
  $('modeLabel').textContent = on ? 'Down payment mode' : 'Mode';
  $('receivedLabel').textContent = on ? 'Down payment' : 'Amount received';
  $('receivedFull').hidden = on;
}
const narrationTemplate = () => financeList().find(f => f.id === $('financeCo').value)?.template ?? FINANCE_TEMPLATE;
// Keeps the narration's template part up to date with the bill (amounts, EMI date, company) until the user edits that part.
// `force` puts the template in even when it isn't there yet (a company was just chosen).
function syncNarration(inv, { force = false } = {}) {
  const el = $('notes'), current = el.value, wanted = inv.finance ? financeNarration(narrationTemplate(), inv) : '';
  const figures = inv.finance ? financeValues(inv) : null;
  let next = current;
  if (autoNarration && current.endsWith(autoNarration)) {
    const before = current.slice(0, current.length - autoNarration.length);
    next = wanted ? before + wanted : before.replace(/\s+$/, '');
    autoNarration = wanted;
  } else if (force && wanted) {
    next = current.trim() ? `${current.replace(/\s+$/, '')}\n${wanted}` : wanted;
    autoNarration = wanted;
  } else if (figures && narrationFigures) next = swapFigures(current, narrationFigures, figures); // edited by hand: only swap changed figures
  narrationFigures = figures;
  if (next !== current) el.value = next.slice(0, NARRATION_MAX);
}
function onFinanceChange() {
  const f = financeList().find(x => x.id === $('financeCo').value);
  if (f) $('emiDay').value = String(f.emiDay);
  financeTouched = false;
  if (!$('financeCo').value) receivedTouched = false;
  toggleFinance();
  const inv = readForm(); syncNarration(inv, { force: Boolean(inv.finance) });
}
async function fillNarrationFromTemplate() {
  const inv = readForm(); if (!inv.finance) return;
  const wanted = financeNarration(narrationTemplate(), inv), current = $('notes').value.trim();
  if (current && current !== autoNarration && current !== wanted && !(await confirmBox('Replace the narration?', `The narration will be replaced with the ${inv.finance.name} template. What is written there now will be removed.`, 'Replace'))) return;
  $('notes').value = wanted.slice(0, NARRATION_MAX); autoNarration = wanted; narrationFigures = financeValues(inv); changed();
}
$('narrationFill').onclick = fillNarrationFromTemplate;

function readForm() {
  const profile = formProfile(), s = profileSettings(S().settings, profile), noGst = !s.gst, base = editing || {};
  const business = editing ? Object.fromEntries(Object.keys(BUSINESS_DEFAULTS).map(k => [k, editing[k] ?? s[k]])) : Object.fromEntries(Object.keys(BUSINESS_DEFAULTS).map(k => [k, s[k]]));
  const supplyType = noGst ? 'intra' : $('supplyType').value;
  const inv = {
    id: base.id, invoiceNo: base.invoiceNo || $('invoiceNo').value, createdAt: base.createdAt, updatedAt: base.updatedAt, createdBy: base.createdBy, status: base.status || 'active',
    profile, noGst, date: $('date').value,
    customer: {
      name: cleanText($('customerName').value, 100), phone: cleanText($('phone').value, 20).replace(/[^0-9+ -]/g, ''), address: cleanText($('address').value, 300),
      gstin: noGst ? '' : cleanText($('customerGstin').value, 15).toUpperCase(), state: supplyType === 'inter' ? cleanText($('customerState').value, 50).toUpperCase() : '', stateCode: supplyType === 'inter' ? cleanText($('customerStateCode').value, 5) : ''
    },
    items: readItems(noGst), supplyType, ...business, roundUp: editing ? Boolean(editing.roundUp) : s.roundUp,
    payment: { mode: $('paymentMode').value, received: 0, reference: cleanText($('paymentRef').value, 60), history: base.payment?.history || [] }, notes: cleanText($('notes').value, NARRATION_MAX),
    finance: null
  };
  const t = calcInvoice({ ...inv, payment: { received: 0 } }), fin = financeFromForm();
  if (fin) {
    // Whichever of down payment / finance amount was typed decides the other: together they make the bill total.
    const typedFinance = Math.max(0, Number($('financeAmount').value) || 0);
    if (!receivedTouched) $('received').value = financeTouched ? Math.max(0, t.grandTotal - typedFinance).toFixed(2) : '0.00';
    const down = Math.min(t.grandTotal, Math.max(0, Number($('received').value) || 0));
    if (!financeTouched) $('financeAmount').value = Math.max(0, t.grandTotal - down).toFixed(2);
    inv.finance = { ...fin, amount: Math.max(0, Math.round((Number($('financeAmount').value) || 0) * 100) / 100) };
    inv.payment.received = Math.min(Math.max(0, t.grandTotal - inv.finance.amount), down);
    return inv;
  }
  if (!receivedTouched) $('received').value = inv.payment.mode.startsWith('Credit') ? '0' : t.grandTotal.toFixed(2);
  inv.payment.received = Math.min(t.grandTotal, Math.max(0, Number($('received').value) || 0));
  return inv;
}
function setForm(inv) {
  $('customerName').value = inv.customer?.name || ''; $('phone').value = inv.customer?.phone || ''; $('address').value = inv.customer?.address || '';
  $('customerGstin').value = inv.customer?.gstin || ''; $('supplyType').value = inv.supplyType || 'intra';
  $('customerState').value = inv.customer?.state || ''; $('customerStateCode').value = inv.customer?.stateCode || '';
  $('invoiceNo').value = inv.invoiceNo || ''; $('date').value = inv.date || today();
  $('itemRows').innerHTML = ''; (inv.items?.length ? inv.items : [{}]).forEach(it => $('itemRows').appendChild(createItemRow(it))); updateRemoveButtons();
  $('paymentMode').value = inv.payment?.mode || 'Cash'; $('received').value = inv.payment ? Number(inv.payment.received || 0).toFixed(2) : '';
  $('paymentRef').value = inv.payment?.reference || ''; $('notes').value = inv.notes || '';
  renderFinanceOptions(inv.finance ? inv.finance.id || 'saved' : '', inv.finance?.name || '');
  $('emiDay').value = String(inv.finance?.emiDay || 3); $('financeAmount').value = inv.finance ? Number(inv.finance.amount || 0).toFixed(2) : '';
  financeTouched = Boolean(inv.finance);
  // If the saved narration still ends with the untouched template text, keep updating that part when amounts change.
  const filled = inv.finance ? financeNarration(narrationTemplate(), inv) : '';
  autoNarration = filled && (inv.notes || '').endsWith(filled) ? filled : '';
  narrationFigures = inv.finance ? financeValues(inv) : null;
  receivedTouched = Boolean(inv.payment); formDirty = false;
  $('customerMore').open = Boolean(inv.customer?.address || inv.customer?.gstin || inv.supplyType === 'inter');
  toggleInter(); toggleFinance(); updateBanner(); renderPreview();
}
function newInvoice() {
  editing = null;
  setForm({ date: today(), supplyType: 'intra', items: [{}] });
  receivedTouched = false; formDirty = false; setStatus('');
  refreshInvoiceNo(); updateBanner();
}
function refreshInvoiceNo() {
  if (editing) return;
  if (!S().settings) return;
  const date = $('date').value || today(), year = financialYear(date), profile = formProfile(), s = profileSettings(S().settings, profile);
  $('invoiceNo').value = formatInvoiceNo(s, year, nextCounter(S().counters, S().invoices, year, s, profile));
  if (currentView === 'billing') renderPreview();
}
function toggleInter() {
  const inter = $('supplyType').value === 'inter';
  document.querySelectorAll('.inter-only').forEach(el => { el.hidden = !inter; });
  if (inter) $('customerMore').open = true;
}
function updateBanner() {
  const b = $('editBanner');
  $('saleTitle').textContent = editing ? (editing.status === 'cancelled' ? 'Cancelled bill' : 'Sale invoice') : 'New sale';
  if (!editing) { b.hidden = true; $('saveInvoice').textContent = 'Save bill'; return; }
  b.hidden = false;
  b.innerHTML = `Editing <strong>${esc(editing.invoiceNo)}</strong>${editing.status === 'cancelled' ? ' — <span class="badge cancelled">Cancelled</span>' : ''}<span class="spacer"></span><button type="button" class="secondary small" id="dupBtn">Copy as new bill</button><button type="button" class="secondary small" id="closeEdit">Close</button>`;
  $('saveInvoice').textContent = formDirty ? 'Save changes' : 'Saved ✓';
  $('dupBtn').onclick = () => duplicateInvoice(editing);
  $('closeEdit').onclick = () => newInvoice();
}
function changed() { formDirty = true; if (editing) updateBanner(); renderPreview(); }
function setStatus(message, type = 'ok') { $('status').textContent = message; $('status').dataset.type = type; }

$('invoiceForm').addEventListener('input', e => { if (e.target.id === 'received') receivedTouched = true; if (e.target.id === 'financeAmount') financeTouched = true; changed(); });
$('invoiceForm').addEventListener('change', e => {
  if (e.target.id === 'supplyType') toggleInter();
  if (e.target.id === 'paymentMode' && !$('financeCo').value) receivedTouched = false; // a typed down payment stays when its mode changes
  if (e.target.id === 'financeCo') onFinanceChange();
  if (e.target.id === 'date' && !editing) refreshInvoiceNo();
  changed();
});
$('addItem').onclick = () => { $('itemRows').appendChild(createItemRow({})); updateRemoveButtons(); $('itemRows').lastElementChild.querySelector('.it-model').focus(); changed(); };
$('receivedFull').onclick = () => { receivedTouched = false; changed(); };
$('newInvoice').onclick = async () => { if (formDirty && !(await confirmBox('Start a new bill?', 'Changes on this form that are not saved will be lost.', 'New bill'))) return; newInvoice(); };

$('invoiceForm').addEventListener('submit', async e => {
  e.preventDefault();
  const inv = readForm(), errors = validateInvoice(inv);
  if (errors.length) { setStatus(errors.join(' '), 'error'); return; }
  const btn = $('saveInvoice'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    let saved;
    if (editing) { saved = await store.updateInvoice(inv); toast(`${saved.invoiceNo} updated.`); }
    else {
      delete inv.id; saved = await store.createInvoice(inv);
      toast(`Bill ${saved.invoiceNo} saved ${store.where}.`);
      adjustStock(saved.items, -1);
    }
    editing = saved; setForm(saved); setStatus(''); // the toast says it was saved, and the button says Saved ✓
  } catch (error) { setStatus(friendlyError(error), 'error'); }
  finally { btn.disabled = false; updateBanner(); }
});
function adjustStock(items, sign, profile = activeProfile()) {
  for (const it of items) {
    const p = S().products.find(x => profileOf(x) === profile && x.name.toLowerCase() === it.model.toLowerCase());
    if (p && p.stock != null) store.saveProduct({ ...p, stock: p.stock + sign * it.quantity }).catch(() => {});
  }
}
function requireSaved(action) {
  if (!editing) { setStatus(`Save the bill first, then ${action}.`, 'error'); return null; }
  if (formDirty) { setStatus(`Save your changes first, then ${action}.`, 'error'); return null; }
  return editing;
}
$('pdfInvoice').onclick = async () => { const inv = requireSaved('make the PDF'); if (inv) await downloadPdf(inv); };
$('printInvoice').onclick = () => { if (requireSaved('print')) window.print(); };
$('whatsappInvoice').onclick = () => { const inv = requireSaved('share it'); if (inv) shareWhatsApp(inv); };

async function downloadPdf(inv) {
  try { await saveFile(makeInvoicePdf(inv, { signature: await signatureForPdf(S().settings?.signature) }), invoiceFilename(inv), 'application/pdf'); }
  catch (error) { toast(`Could not create PDF: ${error.message || error}`, 'error'); }
}
function waLink(phone, text) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
function shareWhatsApp(inv) {
  const t = calcInvoice(inv), s = S().settings;
  const lines = [`Dear ${inv.customer.name},`, `Thank you for shopping at ${inv.businessName || s.businessName}.`, '', `Invoice: ${inv.invoiceNo}`, `Date: ${dateForDisplay(inv.date)}`,
    ...inv.items.map(i => `• ${i.model} x${i.quantity}`), `Total: ₹${format(t.grandTotal)}`];
  if (t.financeAmount > 0) lines.push(`Down payment: ₹${format(t.downPayment)}`, `Finance (${inv.finance.name}): ₹${format(t.financeAmount)}`);
  if (t.balance > 0.004) lines.push(`Balance due: ₹${format(t.balance)}`);
  if (inv.notes) lines.push('', inv.notes);
  window.open(waLink(inv.customer.phone, lines.join('\n')), '_blank');
}
function duplicateInvoice(inv) {
  const copy = { ...inv, items: inv.items.map(i => ({ ...i, imei: '' })), date: today(), payment: undefined, status: 'active' };
  editing = null; setForm(copy); receivedTouched = false; formDirty = true; refreshInvoiceNo(); updateBanner(); show('billing');
  setStatus('Copied into a new bill. IMEIs were cleared — add them and save.');
}
function openInvoice(inv) { editing = inv; setForm(inv); show('billing'); setStatus(''); }

/* ---------- invoice preview (also what Print prints) ---------- */
// "Received" on the bill, or the down payment and the finance company's part for a financed bill.
function receivedRows(inv, t) {
  return t.financeAmount > 0 ? [['Down payment', t.downPayment], [`Finance (${inv.finance.name})`, t.financeAmount]] : [['Received', t.received]];
}
function renderPreview() {
  if (!$('itemRows').children.length) return;
  const inv = readForm();
  syncNarration(inv); inv.notes = cleanText($('notes').value, NARRATION_MAX);
  const t = calcInvoice(inv), len = $('notes').value.length;
  $('balanceDue').value = format(t.balance);
  // Save bar + header
  $('barTotal').textContent = money(t.grandTotal);
  const bal = $('barBalance');
  bal.className = t.balance > 0.004 ? 'due-text' : '';
  bal.textContent = inv.status === 'cancelled' ? 'Cancelled' : t.balance > 0.004 ? `Balance ${money(t.balance)}` : t.grandTotal > 0 ? (t.financeAmount > 0 ? `Down ${money(t.downPayment)} + finance ${money(t.financeAmount)}` : 'Fully paid') : '';
  $('saleSub').textContent = `${inv.invoiceNo || ''} · ${dateForDisplay(inv.date)}`;
  updateItemRowsUI();
  $('narrationCount').textContent = len > NARRATION_MAX * 0.8 ? `${len} / ${NARRATION_MAX}` : '';
  const g = !inv.noGst; // GST bill (main shop) or plain bill (second shop)
  const taxCells = it => g ? `<td class="num">${it.taxRate}%</td><td class="num">${format(it.net)}</td>${t.inter ? `<td class="num">${format(it.igst)}</td>` : `<td class="num">${format(it.cgst)}</td><td class="num">${format(it.sgst)}</td>`}` : '';
  const rows = t.items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.model)}${it.imei ? `<br><small>IMEI: ${esc(it.imei)}</small>` : ''}</td>${g ? `<td>${esc(it.hsn)}</td>` : ''}<td class="num">${it.quantity}</td><td class="num">${format(it.price)}</td>${t.discount ? `<td class="num">${format(it.discount)}</td>` : ''}${taxCells(it)}<td class="num"><strong>${format(it.lineTotal)}</strong></td></tr>`).join('');
  const roundRow = Math.abs(t.roundOff) > 0.004 ? [['Round off', t.roundOff]] : [];
  const sumRows = g ? [['Taxable amount', t.net], ...(t.inter ? [['IGST', t.igst]] : [['CGST', t.cgst], ['SGST', t.sgst]]), ...(t.discount ? [['Discount given', t.discount]] : []), ...roundRow]
    : [...(t.discount ? [['Amount', t.total + t.discount], ['Less discount', -t.discount]] : []), ...roundRow];
  const pos = t.inter ? `${esc(inv.customer.state || 'Other state')}${inv.customer.stateCode ? ` (${esc(inv.customer.stateCode)})` : ''}` : `${esc(inv.state)} (${esc(inv.stateCode)})`;
  $('invoicePreview').innerHTML = `
    <header class="invoice-head"><h1>${esc(inv.businessName)}</h1><p>${esc(inv.businessAddress)}</p>${inv.businessPhone || inv.businessEmail ? `<p>${inv.businessPhone ? `Ph: ${esc(inv.businessPhone)}` : ''}${inv.businessPhone && inv.businessEmail ? ' · ' : ''}${esc(inv.businessEmail)}</p>` : ''}</header>
    <div class="invoice-title">${g ? 'TAX INVOICE' : 'INVOICE'}${inv.status === 'cancelled' ? ' <span class="stamp">CANCELLED</span>' : ''}${g ? '<small>Original for Recipient</small>' : ''}</div>
    ${g ? `<div class="gst-row"><span><strong>GSTIN: ${esc(inv.gstin)}</strong></span><span>State: ${esc(inv.state)} &nbsp; Code: ${esc(inv.stateCode)}</span></div>` : ''}
    <section class="invoice-meta"><span><strong>Invoice No: ${esc(inv.invoiceNo)}</strong>${g ? `<br>Place of supply: ${pos}` : ''}</span><span class="r"><strong>Date: ${dateForDisplay(inv.date)}</strong><br>Payment: ${esc(paymentLabel(inv))}</span></section>
    <section class="customer"><small>Bill to</small><br><strong>${esc(inv.customer.name) || '&nbsp;'}</strong>${inv.customer.address ? `<br>${esc(inv.customer.address)}` : ''}${inv.customer.phone ? `<br>Mobile: ${esc(inv.customer.phone)}` : ''}${inv.customer.gstin ? `<br>GSTIN: ${esc(inv.customer.gstin)}` : ''}</section>
    <div class="table-scroll"><table class="item-table"><thead><tr><th>Sl</th><th>Item</th>${g ? '<th>HSN</th>' : ''}<th class="num">Qty</th><th class="num">Rate</th>${t.discount ? '<th class="num">Disc</th>' : ''}${g ? `<th class="num">GST</th><th class="num">Taxable</th>${t.inter ? '<th class="num">IGST</th>' : '<th class="num">CGST</th><th class="num">SGST</th>'}` : ''}<th class="num">Total</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td></td><td><strong>Total</strong></td>${g ? '<td></td>' : ''}<td class="num">${t.qty}</td><td></td>${t.discount ? `<td class="num">${format(t.discount)}</td>` : ''}${g ? `<td></td><td class="num">${format(t.net)}</td>${t.inter ? `<td class="num">${format(t.igst)}</td>` : `<td class="num">${format(t.cgst)}</td><td class="num">${format(t.sgst)}</td>`}` : ''}<td class="num"><strong>${format(t.total)}</strong></td></tr></tfoot></table></div>
    <div class="summary"><table>${sumRows.map(([l, v]) => `<tr><td>${l}</td><td>${v < 0 ? '-' : ''}${format(Math.abs(v))}</td></tr>`).join('')}<tr class="grand"><td>Grand Total</td><td>₹${format(t.grandTotal)}</td></tr>
      ${inv.status !== 'cancelled' ? `${receivedRows(inv, t).map(([l, v]) => `<tr><td>${esc(l)}</td><td>${format(v)}</td></tr>`).join('')}${t.balance > 0.004 ? `<tr class="due"><td>Balance due</td><td>${format(t.balance)}</td></tr>` : ''}` : ''}</table></div>
    <p class="words">${numberToWords(t.grandTotal)}</p>
    ${inv.notes ? `<div class="narration"><strong>Narration</strong>${esc(inv.notes)}</div>` : ''}${inv.bankDetails ? `<p class="small-note">Bank: ${esc(inv.bankDetails)}</p>` : ''}
    <footer class="foot"><span>${esc(inv.terms)} Certified that the particulars given above are true and correct.</span><span class="signature">For ${esc(inv.businessName)}${S().settings?.signature ? `<img src="${S().settings.signature}" alt="Signature">` : ''}<div>Authorised Signatory</div></span></footer>`;
}

/* ---------- autocomplete: customers on name/phone, products on item name ---------- */
function customerDirectory() {
  const map = new Map();
  for (const inv of myInvoices().sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    const name = (inv.customer?.name || '').trim(), key = customerKeyOf(inv);
    if (!key) continue;
    const t = calcInvoice(inv), c = map.get(key) || { key, name, phone: inv.customer.phone, count: 0, total: 0, due: 0, last: '', customer: inv.customer };
    if (inv.status !== 'cancelled') { c.count++; c.total += t.grandTotal; c.due += t.balance; }
    c.last = inv.date; c.name = name || c.name; c.customer = { ...c.customer, ...Object.fromEntries(Object.entries(inv.customer).filter(([, v]) => v)) };
    map.set(key, c);
  }
  return [...map.values()].sort((a, b) => (b.last || '').localeCompare(a.last || ''));
}
function attachList(input, list, getMatches, onPick) {
  let matches = [];
  const draw = () => {
    matches = getMatches(input.value.trim());
    if (!matches.length) { list.hidden = true; return; }
    list.innerHTML = matches.map((m, i) => `<button type="button" data-i="${i}"><strong>${esc(m.title)}</strong><span>${esc(m.sub)}</span></button>`).join('');
    list.hidden = false;
    list.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', e => { e.preventDefault(); onPick(matches[b.dataset.i].value); list.hidden = true; }));
  };
  input.addEventListener('input', draw);
  input.addEventListener('focus', () => { if (input.value.trim()) draw(); });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') list.hidden = true; });
}
function pickCustomer(c) {
  $('customerName').value = c.name || ''; $('phone').value = c.customer.phone || ''; $('address').value = c.customer.address || ''; $('customerGstin').value = c.customer.gstin || '';
  if (c.customer.stateCode && P().gst) { $('supplyType').value = 'inter'; $('customerState').value = c.customer.state || ''; $('customerStateCode').value = c.customer.stateCode; toggleInter(); }
  if (c.customer.address || c.customer.gstin) $('customerMore').open = true;
  changed();
}
['customerName', 'phone'].forEach(id => {
  const input = $(id);
  attachList(input, input.parentElement.querySelector('.ac-list'), q => {
    if (!q) return []; const ql = q.toLowerCase();
    return customerDirectory().filter(c => c.name.toLowerCase().includes(ql) || (c.phone || '').includes(q)).slice(0, 6).map(c => ({ title: c.name || 'Unnamed', sub: `${c.phone || ''}${c.due > 0.004 ? ` · due ${money(c.due)}` : ''}`, value: c }));
  }, pickCustomer);
});
// Products of the current shop matching what was typed: an exact item number (barcode) first, then item numbers
// starting with it, then names containing it. In the products list a dealer price code also matches exactly.
const productByItemNo = (value, profile = activeProfile()) => { const v = String(value || '').trim().toLowerCase(); return v ? S().products.find(p => profileOf(p) === profile && p.itemNo && p.itemNo.toLowerCase() === v) : null; };
function findProducts(query, { dealerCode = false } = {}) {
  const q = query.trim().toLowerCase(), Q = q.toUpperCase(); if (!q) return [];
  const rank = p => { const no = (p.itemNo || '').toLowerCase(); return no === q ? 0 : no && no.startsWith(q) ? 1 : p.name.toLowerCase().includes(q) ? 2 : dealerCode && p.code && p.code === Q ? 3 : 9; };
  return myProducts().map(p => [rank(p), p]).filter(([r]) => r < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, p]) => p);
}
const productSub = p => [p.itemNo && `#${p.itemNo}`, money(p.price), P().gst ? `${p.taxRate}%` : '', p.code && `Code ${p.code}`, p.stock != null && `stock ${p.stock}`].filter(Boolean).join(' · ');
function wireProductAutocomplete(row) {
  const input = row.querySelector('.it-model'), list = row.querySelector('.ac-list');
  const pick = (p, scanned = false) => {
    input.value = p.name; row.querySelector('.it-hsn').value = p.hsn; row.querySelector('.it-tax').value = String(p.taxRate);
    if (p.price) row.querySelector('.it-price').value = p.price;
    list.hidden = true; changed();
    // Phones in the GST shop need an IMEI next. After a barcode scan of anything else, open a fresh row for the next scan.
    if (P().gst && p.hsn === '85171300') row.querySelector('.it-imei').focus();
    else if (scanned) { if (row === $('itemRows').lastElementChild) $('addItem').click(); else row.nextElementSibling.querySelector('.it-model').focus(); }
    else row.querySelector('.it-qty').focus();
  };
  attachList(input, list, q => findProducts(q).slice(0, 8).map(p => ({ title: p.name, sub: productSub(p), value: p })), p => pick(p));
  // Barcode scanners type the item number quickly (usually followed by Enter): pick the product as soon as it matches.
  input.addEventListener('input', () => { const p = productByItemNo(input.value); if (p) pick(p, true); });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // Enter in the item box picks an item and never saves the bill
    const exact = productByItemNo(input.value), p = exact || (!list.hidden && findProducts(input.value)[0]);
    if (p) pick(p, Boolean(exact));
  });
}
// A scanner's Enter after an IMEI should not save the bill either: move on to the next item instead.
$('itemRows').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('.it-imei, .it-qty, .it-price, .it-disc, .it-hsn')) return;
  e.preventDefault();
  const row = e.target.closest('.item-row');
  if (e.target.matches('.it-imei') && row === $('itemRows').lastElementChild) $('addItem').click();
});

/* =========================================================================
   Bills list
   ========================================================================= */
const statusLabel = { paid: 'Paid', partial: 'Part paid', due: 'Due', cancelled: 'Cancelled' };
function invoiceMatches(inv, q) {
  return !q || `${inv.invoiceNo} ${inv.customer.name} ${inv.customer.phone} ${inv.customer.gstin} ${inv.items.map(i => `${i.model} ${i.imei}`).join(' ')} ${inv.finance?.name || ''} ${inv.notes || ''}`.toLowerCase().includes(q);
}
// A bill in a list: tap it to open; Receive (when due), PDF and the ⋯ menu on the right.
function billCard(inv) {
  const t = calcInvoice(inv), st = paymentStatus(inv), items = inv.items, due = t.balance > 0.004;
  const summary = items.length > 1 ? `${items[0].model} +${items.length - 1} more` : items[0]?.model;
  return `<div class="bill" data-id="${esc(inv.id)}">
    <span class="avatar${st === 'cancelled' ? ' slate' : due ? ' red' : ''}">${esc(initials(inv.customer.name || '?'))}</span>
    <div class="bill-main"><strong>${esc(inv.customer.name)}</strong>${inv.finance ? ` <span class="badge finance">${esc(inv.finance.name)}</span>` : ''}
      <small>${esc(inv.invoiceNo)} · ${dateForDisplay(inv.date)}${inv.customer.phone ? ` · ${esc(inv.customer.phone)}` : ''}</small><small>${esc(summary)}</small></div>
    <div class="bill-amt"><strong>${money(t.grandTotal)}</strong><br><span class="badge ${st}">${st === 'partial' ? `Due ${money(t.balance)}` : statusLabel[st]}</span></div>
    <div class="bill-actions">
      ${due ? '<button type="button" class="small" data-act="pay">Receive</button>' : ''}
      <button type="button" class="icon-btn hide-phone" data-act="pdf" title="PDF" aria-label="Download PDF">${icon('file', 18)}</button>
      <button type="button" class="icon-btn" data-act="more" title="More" aria-label="More actions">${icon('dots', 18)}</button>
    </div></div>`;
}
function wireBillActions(container) {
  container.querySelectorAll('.bill[data-id]').forEach(el => el.addEventListener('click', async e => {
    const inv = S().invoices.find(i => i.id === el.dataset.id); if (!inv) return;
    const act = e.target.closest('[data-act]')?.dataset.act || 'open';
    if (act === 'open') openInvoice(inv);
    if (act === 'pdf') downloadPdf(inv);
    if (act === 'pay') receivePayment(inv);
    if (act === 'more') {
      const r = await dialog(`<h3>${esc(inv.invoiceNo)}</h3><p>${esc(inv.customer.name)} · ${money(calcInvoice(inv).grandTotal)}</p><div class="menu">
        <button class="secondary" data-result="open">${icon('receipt', 18)}Open bill</button><button class="secondary" data-result="pdf">${icon('file', 18)}Download PDF</button>
        <button class="secondary" data-result="wa">${icon('chat', 18)}Send on WhatsApp</button><button class="secondary" data-result="dup">${icon('plus', 18)}Copy as new bill</button>
        ${inv.status === 'cancelled' ? '<button class="secondary" data-result="restore">Restore (un-cancel)</button>' : '<button class="danger" data-result="cancel">Cancel this bill</button>'}
        <button class="secondary" data-result="close">Close</button></div>`);
      if (r === 'open') openInvoice(inv);
      if (r === 'pdf') downloadPdf(inv);
      if (r === 'wa') shareWhatsApp(inv);
      if (r === 'dup') duplicateInvoice(inv);
      if (r === 'cancel' && await confirmBox('Cancel this bill?', `${inv.invoiceNo} will be marked cancelled and left out of sales and GST totals. The number stays used, as GST rules require.`, 'Cancel bill', true)) {
        await store.updateInvoice({ ...inv, status: 'cancelled' }); adjustStock(inv.items, +1, profileOf(inv)); toast(`${inv.invoiceNo} cancelled.`);
      }
      if (r === 'restore') { await store.updateInvoice({ ...inv, status: 'active' }); adjustStock(inv.items, -1, profileOf(inv)); toast(`${inv.invoiceNo} restored.`); }
    }
  }));
}
async function receivePayment(inv) {
  const t = calcInvoice(inv);
  const r = await dialog(`<h3>Receive payment</h3><p>${esc(inv.invoiceNo)} · ${esc(inv.customer.name)}<br>Balance due: <strong>${money(t.balance)}</strong></p>
    <div class="form-grid"><label>Amount<input id="dlgAmt" type="number" step="0.01" min="0.01" value="${t.balance.toFixed(2)}"></label><label>Mode<select id="dlgMode">${PAYMENT_MODES.filter(m => !m.startsWith('Credit')).map(m => `<option>${m}</option>`).join('')}</select></label></div>
    <div class="actions end"><button class="secondary" data-result="no">Cancel</button><button id="dlgOk">Save payment</button></div>`, (body, done) => {
    body.querySelector('#dlgOk').addEventListener('click', e => { e.preventDefault(); done({ amount: Number(body.querySelector('#dlgAmt').value) || 0, mode: body.querySelector('#dlgMode').value }); });
  });
  if (!r || typeof r !== 'object' || r.amount <= 0) return;
  // `payment.received` is what the customer paid (the down payment on a financed bill); the finance company's part is separate.
  const received = Math.min(t.grandTotal - t.financeAmount, t.downPayment + r.amount);
  const mode = inv.payment.mode.startsWith('Credit') || inv.payment.mode === r.mode ? r.mode : inv.payment.mode;
  const history = [...(inv.payment.history || []), { date: today(), amount: r.amount, mode: r.mode }];
  await store.updateInvoice({ ...inv, payment: { ...inv.payment, mode, received, history } });
  toast(`Received ${money(r.amount)} for ${inv.invoiceNo}.`);
}
function renderBills() {
  const q = $('billSearch').value.trim().toLowerCase(), from = $('billFrom').value, to = $('billTo').value, st = $('billStatus').value;
  const statusOk = i => !st || (st === 'finance' ? Boolean(i.finance) : st === 'open' ? ['due', 'partial'].includes(paymentStatus(i)) : paymentStatus(i) === st);
  const list = myInvoices().filter(i => invoiceMatches(i, q) && (!from || i.date >= from) && (!to || i.date <= to) && statusOk(i))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const shown = list.slice(0, billLimit), active = list.filter(i => i.status !== 'cancelled');
  const due = active.reduce((s, i) => s + calcInvoice(i).balance, 0);
  $('billSummary').innerHTML = list.length ? `<span><strong>${list.length}</strong> bill${list.length === 1 ? '' : 's'}</span><span>Sales <strong>${money(active.reduce((s, i) => s + calcInvoice(i).grandTotal, 0))}</strong></span>${due > 0.004 ? `<span class="due-text">To collect <strong>${money(due)}</strong></span>` : ''}` : '';
  if (!list.length) { $('billList').innerHTML = `<p class="empty">${myInvoices().length ? 'No bills match.' : 'No bills yet. Tap “New sale” to make your first one.'}</p>`; return; }
  let html = '', lastDate = '';
  for (const inv of shown) { if (inv.date !== lastDate) { lastDate = inv.date; html += `<div class="day">${dateForDisplay(inv.date)}</div>`; } html += billCard(inv); }
  if (list.length > shown.length) html += `<button type="button" class="secondary more-btn" id="moreBills">Show more (${list.length - shown.length} left)</button>`;
  $('billList').innerHTML = html; wireBillActions($('billList'));
  $('moreBills')?.addEventListener('click', () => { billLimit += 100; renderBills(); });
}
let billLimit = 100;
['billSearch', 'billFrom', 'billTo', 'billStatus'].forEach(id => $(id).addEventListener('input', () => { billLimit = 100; renderBills(); }));
function setBillFilter(status) {
  $('billStatus').value = status;
  document.querySelectorAll('#billChips [data-status]').forEach(c => c.classList.toggle('active', c.dataset.status === status));
}
$('billChips').addEventListener('click', e => { const c = e.target.closest('[data-status]'); if (!c) return; setBillFilter(c.dataset.status); billLimit = 100; renderBills(); });

/* =========================================================================
   Customers
   ========================================================================= */
const customerKeyOf = inv => (inv.customer?.phone || '').replace(/\s/g, '') || (inv.customer?.name || '').trim().toLowerCase();
function renderCustomers() {
  const q = $('customerSearch').value.trim().toLowerCase(), duesOnly = $('customerDuesOnly').checked;
  const all = customerDirectory(), list = all.filter(c => (!q || `${c.name} ${c.phone}`.toLowerCase().includes(q)) && (!duesOnly || c.due > 0.004));
  const due = all.reduce((s, c) => s + c.due, 0);
  $('customerSummary').innerHTML = all.length ? `${all.length} customer${all.length === 1 ? '' : 's'}${due > 0.004 ? ` · <span class="due-text">to collect ${money(due)}</span>` : ''}` : 'Made automatically from your bills';
  if (!list.length) { $('customerList').innerHTML = `<p class="empty">${all.length ? 'No customers match.' : 'Customers appear here automatically once you save bills.'}</p>`; return; }
  $('customerList').innerHTML = list.slice(0, 300).map(c => `<div class="bill" data-key="${esc(c.key)}">
    <span class="avatar${c.due > 0.004 ? ' red' : ''}">${esc(initials(c.name || '?'))}</span>
    <div class="bill-main"><strong>${esc(c.name) || 'Unnamed'}</strong><small>${esc(c.phone || 'No phone')} · ${c.count} bill${c.count === 1 ? '' : 's'} · last ${dateForDisplay(c.last)}</small></div>
    <div class="bill-amt">${c.due > 0.004 ? `<strong class="due-text">${money(c.due)}</strong><small>to collect</small>` : `<strong>${money(c.total)}</strong><small>total sales</small>`}</div>
    <span class="chev hide-phone">${icon('chevron', 18)}</span></div>`).join('');
  $('customerList').querySelectorAll('.bill').forEach(el => el.addEventListener('click', () => { const c = list.find(x => x.key === el.dataset.key); if (c) customerDetail(c); }));
}
// One customer: totals, recent bills, and New bill / WhatsApp / Call.
async function customerDetail(c) {
  const bills = myInvoices().filter(i => customerKeyOf(i) === c.key).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const phone = String(c.phone || '').replace(/[^0-9+]/g, '');
  const r = await dialog(`<div class="cust-head"><span class="avatar${c.due > 0.004 ? ' red' : ''}">${esc(initials(c.name || '?'))}</span><div><h3>${esc(c.name) || 'Unnamed'}</h3><small>${esc(c.phone || 'No phone')}${c.customer?.address ? ` · ${esc(c.customer.address)}` : ''}</small></div></div>
    <div class="cust-stats"><div><small>Bills</small><strong>${c.count}</strong></div><div><small>Total sales</small><strong>${money(c.total)}</strong></div><div><small>To collect</small><strong class="${c.due > 0.004 ? 'due-text' : ''}">${money(c.due)}</strong></div></div>
    <div class="cust-bills">${bills.slice(0, 6).map(i => { const t = calcInvoice(i), st = paymentStatus(i); return `<button type="button" class="cust-bill" data-result="open:${esc(i.id)}"><span>${esc(i.invoiceNo)}<small>${dateForDisplay(i.date)} · ${esc(i.items[0]?.model || '')}${i.items.length > 1 ? ` +${i.items.length - 1}` : ''}</small></span><span class="r"><strong>${money(t.grandTotal)}</strong><span class="badge ${st}">${statusLabel[st]}</span></span></button>`; }).join('')}</div>
    ${bills.length > 6 ? `<button type="button" class="link" data-result="bills">See all ${bills.length} bills</button>` : ''}
    <div class="actions cust-actions">${phone ? `<a class="button" href="tel:${esc(phone)}">${icon('phone', 18)}Call</a><button class="secondary" data-result="wa">${icon('chat', 18)}WhatsApp</button>` : ''}<span class="spacer"></span><button class="secondary" data-result="close">Close</button><button data-result="new">${icon('plus', 18)}New bill</button></div>`);
  if (!r) return;
  if (r === 'new') { newInvoice(); pickCustomer(c); show('billing'); }
  if (r === 'bills') { $('billSearch').value = c.phone || c.name; setBillFilter(''); $('billFrom').value = ''; $('billTo').value = ''; show('bills'); }
  if (r === 'wa') window.open(waLink(c.phone, c.due > 0.004 ? `Dear ${c.name}, a balance of ₹${format(c.due)} is pending at ${P().businessName}. Thank you.` : `Dear ${c.name}, `), '_blank');
  if (r.startsWith('open:')) { const inv = S().invoices.find(i => i.id === r.slice(5)); if (inv) openInvoice(inv); }
}
['customerSearch', 'customerDuesOnly'].forEach(id => $(id).addEventListener('input', renderCustomers));

/* =========================================================================
   Products
   ========================================================================= */
let editingProduct = null;
function renderProducts() {
  const q = $('productSearch').value.trim();
  const all = myProducts(), list = q ? findProducts(q, { dealerCode: true }) : [...all].sort((a, b) => a.name.localeCompare(b.name));
  const missing = all.filter(p => !p.itemNo).length;
  $('numberAll').hidden = !missing; $('numberAll').textContent = `Give item numbers to ${missing} item${missing === 1 ? '' : 's'}`;
  const tracked = all.filter(p => p.stock != null), out = tracked.filter(p => p.stock <= 0).length;
  $('productSummary').innerHTML = all.length ? `${all.length} item${all.length === 1 ? '' : 's'}${tracked.length ? ` · ${tracked.reduce((s, p) => s + Math.max(0, p.stock), 0)} in stock` : ''}${out ? ` · <span class="due-text">${out} out of stock</span>` : ''}` : 'Phones and accessories you sell';
  $('printLabels').disabled = !all.length;
  if (!editingProduct) { $('pItemNo').placeholder = `Auto: ${nextItemNo(S().products, activeProfile())}`; productBarcodePreview(); }
  if (!list.length) { $('productList').innerHTML = `<p class="empty">${all.length ? 'No items match.' : `Add the phones and accessories you sell, so bills fill in ${P().gst ? 'HSN, GST and ' : ''}price automatically.`}</p>`; return; }
  // Tap an item to edit it; the tag button prints its barcode label.
  $('productList').innerHTML = list.map(p => `<div class="bill" data-id="${esc(p.id)}">
    <span class="avatar slate">${icon('box', 20)}</span>
    <div class="bill-main"><strong>${esc(p.name)}</strong>${p.code ? ` <span class="code-pill">${esc(p.code)}</span>` : ''}<small>${[p.itemNo ? `<span class="item-no">#${esc(p.itemNo)}</span>` : 'No item no.', P().gst ? `HSN ${esc(p.hsn)} · GST ${p.taxRate}%` : ''].filter(Boolean).join(' · ')}</small></div>
    <div class="bill-amt"><strong>${money(p.price)}</strong>${p.stock != null ? `<br><span class="badge stock${p.stock <= 0 ? ' low' : ''}">${p.stock <= 0 ? 'Out of stock' : `Stock ${p.stock}`}</span>` : ''}</div>
    <div class="bill-actions"><button type="button" class="icon-btn" data-act="label" title="Print barcode label" aria-label="Print barcode label">${icon('tag', 18)}</button></div></div>`).join('');
  $('productList').querySelectorAll('.bill[data-id]').forEach(el => el.addEventListener('click', e => {
    const p = S().products.find(x => x.id === el.dataset.id); if (!p) return;
    if (e.target.closest('[data-act="label"]')) printLabels([p]); else editProduct(p);
  }));
}
function openProductDialog() { resetProductForm(); if (!$('productDialog').open) $('productDialog').showModal(); $('pName').focus(); }
$('addProduct').onclick = openProductDialog;
$('pClose').onclick = $('pCancel').onclick = () => $('productDialog').close();
$('productDialog').addEventListener('close', () => resetProductForm());
$('pDelete').onclick = async () => {
  const p = editingProduct; if (!p) return;
  if (!await confirmBox('Delete item?', `${p.name} will be removed from your items. Old bills are not affected.`, 'Delete', true)) return;
  await store.deleteProduct(p.id); $('productDialog').close(); toast(`${p.name} deleted.`);
};
function editProduct(p) {
  editingProduct = p;
  $('pName').value = p.name; $('pItemNo').value = p.itemNo || ''; $('pItemNo').placeholder = p.itemNo ? '' : `Auto: ${nextItemNo(S().products, profileOf(p))}`;
  $('pCode').value = p.code || ''; $('pHsn').value = p.hsn; $('pPrice').value = p.price || ''; $('pTax').value = String(p.taxRate); $('pStock').value = p.stock ?? '';
  $('productFormTitle').textContent = 'Edit item'; $('pDelete').hidden = false; $('productStatus').textContent = ''; productBarcodePreview();
  if (!$('productDialog').open) $('productDialog').showModal();
  $('pName').focus();
}
function productBarcodePreview() {
  const value = $('pItemNo').value.trim() || $('pItemNo').placeholder.replace(/^Auto: /, '');
  let svg = ''; try { svg = value && isBarcodeText(value) && !/\s/.test(value) ? barcodeSvg(value) : ''; } catch { svg = ''; }
  $('pBarcode').innerHTML = svg ? `${svg}<strong>${esc(value)}</strong>` : 'Barcode preview: letters, numbers and symbols only, no spaces.';
}
function resetProductForm() {
  editingProduct = null; $('productForm').reset(); $('pTax').value = '18'; $('productFormTitle').textContent = 'Add item'; $('pDelete').hidden = true; $('productStatus').textContent = '';
  $('pItemNo').placeholder = `Auto: ${nextItemNo(S().products, activeProfile())}`; productBarcodePreview();
}
$('pItemNo').addEventListener('input', productBarcodePreview);
$('pItemNo').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('pPrice').focus(); } }); // a scanner's Enter should not save yet
$('productForm').addEventListener('submit', async e => {
  e.preventDefault();
  const profile = editingProduct ? profileOf(editingProduct) : activeProfile();
  const typedNo = $('pItemNo').value.trim();
  if (typedNo && !cleanItemNo(typedNo)) { $('productStatus').textContent = 'The item number can only have letters, numbers and symbols, without spaces.'; return; }
  const itemNo = typedNo || editingProduct?.itemNo || nextItemNo(S().products, profile);
  const p = cleanProduct({ id: editingProduct?.id, profile, itemNo, code: profile === 'second' ? $('pCode').value : '', name: $('pName').value, hsn: $('pHsn').value, price: $('pPrice').value, taxRate: P().gst ? $('pTax').value : 0, stock: $('pStock').value === '' ? null : $('pStock').value });
  if (!p) { $('productStatus').textContent = 'Enter the item name.'; return; }
  if (!editingProduct && myProducts().some(x => x.name.toLowerCase() === p.name.toLowerCase())) { $('productStatus').textContent = 'An item with this name already exists.'; return; }
  const clash = S().products.find(x => profileOf(x) === profile && x.id !== p.id && x.itemNo && x.itemNo.toLowerCase() === p.itemNo.toLowerCase());
  if (clash) { $('productStatus').textContent = `Item number ${p.itemNo} is already used for ${clash.name}. Each item number can be used only once.`; return; }
  await store.saveProduct(p); $('productDialog').close(); toast(`Saved ${p.name} (item no. ${p.itemNo}).`);
});
$('productSearch').addEventListener('input', renderProducts);
// Scanning into the search box: an exact item number opens that product for editing (e.g. to update stock).
$('productSearch').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const p = productByItemNo($('productSearch').value); if (p) { e.preventDefault(); editProduct(p); }
});

/* ---------- item numbers + barcode labels ---------- */
async function numberProducts(products) {
  const out = []; let next = Number(nextItemNo(S().products, activeProfile()));
  for (const p of products) {
    if (p.itemNo) { out.push(p); continue; }
    const saved = { ...p, itemNo: String(next++) };
    await store.saveProduct(saved); out.push(saved);
  }
  return out;
}
$('numberAll').onclick = async () => {
  const missing = myProducts().filter(p => !p.itemNo).sort((a, b) => a.name.localeCompare(b.name));
  if (!missing.length || !await confirmBox('Give item numbers?', `${missing.length} product${missing.length === 1 ? '' : 's'} without an item number will get the next numbers (from ${nextItemNo(S().products, activeProfile())}).`, 'Give numbers')) return;
  await numberProducts(missing); toast(`Item numbers given to ${missing.length} products.`);
};
$('printLabels').onclick = () => {
  const q = $('productSearch').value.trim(), list = q ? findProducts(q, { dealerCode: true }) : [...myProducts()].sort((a, b) => a.name.localeCompare(b.name));
  if (list.length) printLabels(list);
};
async function printLabels(products) {
  const anyStock = products.some(p => p.stock > 0), one = products.length === 1;
  const r = await dialog(`<h3>Print barcode labels</h3>
    <p>${one ? esc(products[0].name) : `${products.length} products${$('productSearch').value.trim() ? ' (the ones shown)' : ''}`}. The PDF fits A4 sticker sheets with 24 labels (3 &times; 8, 63.5 &times; 33.9 mm). On plain paper, cut along the lines.</p>
    <div class="form-grid">
      <label>Copies of each<input id="dlgCopies" type="number" min="1" max="500" value="1"></label>
      <label>Start at label no.<span class="req">For a part-used sheet</span><input id="dlgStart" type="number" min="1" max="24" value="1"></label>
      ${anyStock ? '<label class="check wide"><input type="checkbox" id="dlgStock"> One label per item in stock instead</label>' : ''}
    </div>
    <div class="actions end"><button class="secondary" data-result="no">Cancel</button><button id="dlgOk">Make PDF</button></div>`, (body, done) => {
    body.querySelector('#dlgOk').addEventListener('click', e => { e.preventDefault(); done({ copies: Math.max(1, Math.min(500, Math.floor(Number(body.querySelector('#dlgCopies').value) || 1))), start: Math.max(1, Math.min(24, Math.floor(Number(body.querySelector('#dlgStart').value) || 1))), byStock: Boolean(body.querySelector('#dlgStock')?.checked) }); });
  });
  if (!r || typeof r !== 'object') return;
  try {
    const numbered = await numberProducts(products), shop = P();
    const labels = numbered.flatMap(p => Array(r.byStock ? Math.max(0, p.stock || 0) : r.copies).fill({ shop: shop.businessName, name: p.name, itemNo: p.itemNo, price: p.price, code: p.code }));
    if (!labels.length) { toast('No labels to print: none of these products has stock.', 'error'); return; }
    if (labels.length > 2400) { toast('That is more than 2400 labels. Print fewer at a time.', 'error'); return; }
    await saveFile(makeLabelsPdf(labels, { skip: r.start - 1 }), `labels-${today()}.pdf`, 'application/pdf');
  } catch (error) { toast(`Could not make labels: ${error.message || error}`, 'error'); }
}


/* =========================================================================
   Dashboard + reports
   ========================================================================= */
function monthStart(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }
function summarise(invoices) {
  const r = { count: 0, sales: 0, net: 0, cgst: 0, sgst: 0, igst: 0, received: 0, due: 0, discount: 0, b2b: 0, cancelled: 0, rates: {}, hsn: {}, modes: {}, financed: 0, financeCount: 0, finance: {} };
  for (const inv of invoices) {
    if (inv.status === 'cancelled') { r.cancelled++; continue; }
    const t = calcInvoice(inv);
    r.count++; r.sales += t.grandTotal; r.net += t.net; r.cgst += t.cgst; r.sgst += t.sgst; r.igst += t.igst; r.received += t.received; r.due += t.balance; r.discount += t.discount;
    if (inv.customer.gstin) r.b2b++;
    r.modes[inv.payment.mode] = (r.modes[inv.payment.mode] || 0) + t.downPayment;
    if (t.financeAmount > 0) {
      const name = inv.finance.name, f = r.finance[name] ||= { count: 0, amount: 0, sales: 0 };
      f.count++; f.amount += t.financeAmount; f.sales += t.grandTotal; r.financed += t.financeAmount; r.financeCount++;
      r.modes[`${name} (finance)`] = (r.modes[`${name} (finance)`] || 0) + t.financeAmount;
    }
    for (const it of t.items) {
      const rate = r.rates[it.taxRate] ||= { net: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
      rate.net += it.net; rate.cgst += it.cgst; rate.sgst += it.sgst; rate.igst += it.igst; rate.total += it.lineTotal;
      const h = r.hsn[`${it.hsn}|${it.taxRate}`] ||= { hsn: it.hsn, rate: it.taxRate, qty: 0, net: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
      h.qty += it.quantity; h.net += it.net; h.cgst += it.cgst; h.sgst += it.sgst; h.igst += it.igst; h.total += it.lineTotal;
    }
  }
  return r;
}
// A figure card: label, value, small line under it, colour (tone-green, tone-blue, warn…), icon, extra attributes.
const card = (label, value, sub = '', cls = '', ic = 'rupee', attrs = '') => `<div class="card ${cls}" ${attrs}><span class="card-ic">${icon(ic, 20)}</span><div class="card-body"><small>${label}</small><strong>${value}</strong>${sub ? `<span class="sub">${sub}</span>` : ''}</div></div>`;
function renderDashboard() {
  const inv = myInvoices(), t = today(), ms = monthStart();
  const day = summarise(inv.filter(i => i.date === t)), month = summarise(inv.filter(i => i.date >= ms && i.date <= t)), all = summarise(inv);
  $('todayLabel').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('dashCards').innerHTML = card("Today's sale", money(day.sales), `${day.count} bill${day.count === 1 ? '' : 's'}`, 'tone-green', 'trend') + card('This month', money(month.sales), `${month.count} bill${month.count === 1 ? '' : 's'}`, '', 'calendar')
    + (P().gst ? card('GST this month', money(month.cgst + month.sgst + month.igst), `Taxable ${money(month.net)}`, 'tone-blue', 'percent') : card('Received this month', money(month.received), `Discounts ${money(month.discount)}`, 'tone-blue', 'wallet'))
    + card('To collect', money(all.due), all.due > 0.004 ? 'Tap to see who owes' : 'Nothing pending', all.due > 0.004 ? 'warn clickable' : 'tone-green', 'clock', all.due > 0.004 ? 'data-quick="collect"' : '');
  const days = [...Array(7)].map((_, k) => { const d = new Date(); d.setDate(d.getDate() - (6 - k)); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return { key, label: d.toLocaleDateString('en-IN', { weekday: 'short' }), v: summarise(inv.filter(i => i.date === key)).sales }; });
  const max = Math.max(1, ...days.map(d => d.v));
  $('dashChart').innerHTML = days.map(d => `<div class="bar" title="${dateForDisplay(d.key)}: ${money(d.v)}"><span class="bar-val">${d.v ? `₹${Math.round(d.v).toLocaleString('en-IN')}` : ''}</span><span class="bar-fill" style="height:${Math.max(2, d.v / max * 100)}%"></span><small>${d.label}</small></div>`).join('');
  const dues = customerDirectory().filter(c => c.due > 0.004).sort((a, b) => b.due - a.due).slice(0, 5);
  $('dashDues').innerHTML = dues.length ? dues.map(c => `<div class="line clickable" data-key="${esc(c.key)}"><span>${esc(c.name)}<small>${esc(c.phone || '')}</small></span><strong class="due-text">${money(c.due)}</strong></div>`).join('') : '<p class="empty">No pending payments.</p>';
  $('dashDues').querySelectorAll('[data-key]').forEach(el => el.addEventListener('click', () => { const c = dues.find(x => x.key === el.dataset.key); if (c) customerDetail(c); }));
  const recent = [...inv].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 6);
  $('dashRecent').innerHTML = recent.length ? recent.map(billCard).join('') : '<p class="empty">No bills yet. Tap “New sale” to make your first bill.</p>';
  wireBillActions($('dashRecent'));
}
function setRange(kind) {
  const d = new Date(), t = today();
  if (kind === 'today') { $('repFrom').value = t; $('repTo').value = t; }
  if (kind === 'month') { $('repFrom').value = monthStart(d); $('repTo').value = t; }
  if (kind === 'lastmonth') { const s = new Date(d.getFullYear(), d.getMonth() - 1, 1), e = new Date(d.getFullYear(), d.getMonth(), 0); $('repFrom').value = monthStart(s); $('repTo').value = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`; }
  if (kind === 'fy') { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; $('repFrom').value = `${y}-04-01`; $('repTo').value = `${y + 1}-03-31`; }
  document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === kind));
  renderReports();
}
document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => setRange(b.dataset.range)));
['repFrom', 'repTo'].forEach(id => $(id).addEventListener('input', () => { document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active')); renderReports(); }));
let reportTab = 'pay';
function setReportTab(tab) {
  reportTab = tab;
  $('reportTabs').querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('[data-tab-panel]').forEach(p => { p.hidden = p.dataset.tabPanel !== tab; });
}
$('reportTabs').addEventListener('click', e => { const tab = e.target.closest('[data-tab]')?.dataset.tab; if (tab) setReportTab(tab); });
function reportInvoices() { const f = $('repFrom').value, t = $('repTo').value; return myInvoices().filter(i => (!f || i.date >= f) && (!t || i.date <= t)); }
function renderReports() {
  if (!$('repFrom').value && !$('repTo').value) { setRange('month'); return; }
  if (!P().gst && reportTab === 'gst') setReportTab('pay');
  const r = summarise(reportInvoices());
  const bills = `${r.count} bill${r.count === 1 ? '' : 's'}${r.cancelled ? ` · ${r.cancelled} cancelled` : ''}`;
  $('repCards').innerHTML = (P().gst ? card('Sales (incl. GST)', money(r.sales), bills, 'tone-green', 'trend') + card('Taxable value', money(r.net), '', '', 'receipt') + card('CGST + SGST', money(r.cgst + r.sgst), `${money(r.cgst)} each`, 'tone-blue', 'percent') + card('IGST', money(r.igst), 'Other-state sales', 'tone-blue', 'percent') : card('Sales', money(r.sales), bills, 'tone-green', 'trend'))
    + card('Received', money(r.received), r.financed ? `incl. ${money(r.financed)} from finance` : '', 'tone-green', 'wallet') + card('To collect', money(r.due), '', r.due > 0.004 ? 'warn' : '', 'clock') + (P().gst ? card('B2B bills', String(r.b2b), 'with customer GSTIN', 'tone-violet', 'building') : '') + card('Discounts given', money(r.discount), '', 'tone-amber', 'tag')
    + (r.financeCount ? card('Finance (EMI) sales', money(r.financed), `${r.financeCount} bill${r.financeCount === 1 ? '' : 's'}`, 'tone-violet', 'card') : '');
  const fin = Object.entries(r.finance).sort((a, b) => b[1].amount - a[1].amount);
  $('repFinance').innerHTML = fin.length ? fin.map(([name, f]) => `<div class="line"><span>${esc(name)}<small>${f.count} bill${f.count === 1 ? '' : 's'} · bill total ${money(f.sales)}</small></span><strong>${money(f.amount)}</strong></div>`).join('') : '<p class="empty">No financed bills in this period.</p>';
  const rates = Object.entries(r.rates).sort((a, b) => a[0] - b[0]);
  $('repRates').innerHTML = rates.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Rate</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Total</th></tr></thead><tbody>${rates.map(([k, v]) => `<tr><td>${k}%</td><td class="num">${format(v.net)}</td><td class="num">${format(v.cgst)}</td><td class="num">${format(v.sgst)}</td><td class="num">${format(v.igst)}</td><td class="num">${format(v.total)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No sales in this period.</p>';
  const modes = Object.entries(r.modes).filter(([, v]) => v > 0);
  $('repModes').innerHTML = modes.length ? modes.map(([m, v]) => `<div class="line"><span>${esc(m)}</span><strong>${money(v)}</strong></div>`).join('') : '<p class="empty">No payments in this period.</p>';
  const hsn = Object.values(r.hsn).sort((a, b) => a.hsn.localeCompare(b.hsn));
  $('repHsn').innerHTML = hsn.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>HSN</th><th>Rate</th><th class="num">Qty</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Total</th></tr></thead><tbody>${hsn.map(h => `<tr><td>${esc(h.hsn)}</td><td>${h.rate}%</td><td class="num">${h.qty}</td><td class="num">${format(h.net)}</td><td class="num">${format(h.cgst)}</td><td class="num">${format(h.sgst)}</td><td class="num">${format(h.igst)}</td><td class="num">${format(h.total)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No sales in this period.</p>';
}
function downloadCsv(name, rows) {
  const text = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  saveFile(new TextEncoder().encode(text), `${name}-${$('repFrom').value}_to_${$('repTo').value}.csv`, 'text/csv').catch(e => toast(String(e.message || e), 'error'));
}
const r2 = n => (Math.round(n * 100) / 100).toFixed(2);
$('csvBills').onclick = () => downloadCsv('bills', [['Invoice No', 'Date', 'Status', 'Customer', 'Phone', 'Customer GSTIN', 'Place of supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Round off', 'Grand total', 'Received', 'Balance', 'Payment mode', 'Finance', 'Finance amount', 'Down payment', 'EMI date', 'Narration'],
  ...reportInvoices().sort((a, b) => a.date.localeCompare(b.date) || a.invoiceNo.localeCompare(b.invoiceNo)).map(i => { const t = calcInvoice(i); return [i.invoiceNo, i.date, i.status === 'cancelled' ? 'Cancelled' : statusLabel[paymentStatus(i)], i.customer.name, i.customer.phone, i.customer.gstin, t.inter ? `${i.customer.state} ${i.customer.stateCode}` : `${i.state} ${i.stateCode}`, r2(t.net), r2(t.cgst), r2(t.sgst), r2(t.igst), r2(t.roundOff), r2(t.grandTotal), r2(t.received), r2(t.balance), i.payment.mode, i.finance?.name || '', i.finance ? r2(t.financeAmount) : '', i.finance ? r2(t.downPayment) : '', i.finance ? ordinal(i.finance.emiDay) : '', i.notes || '']; })]);
$('csvItems').onclick = () => downloadCsv('items', [['Invoice No', 'Date', 'Customer', 'Item', 'HSN', 'IMEI', 'Qty', 'Rate', 'Discount', 'GST %', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
  ...reportInvoices().filter(i => i.status !== 'cancelled').flatMap(i => calcInvoice(i).items.map(it => [i.invoiceNo, i.date, i.customer.name, it.model, it.hsn, it.imei, it.quantity, r2(it.price), r2(it.discount), it.taxRate, r2(it.net), r2(it.cgst), r2(it.sgst), r2(it.igst), r2(it.lineTotal)]))]);
$('csvHsn').onclick = () => downloadCsv('hsn-summary', [['HSN', 'GST %', 'Qty', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
  ...Object.values(summarise(reportInvoices()).hsn).map(h => [h.hsn, h.rate, h.qty, r2(h.net), r2(h.cgst), r2(h.sgst), r2(h.igst), r2(h.total)])]);

/* =========================================================================
   Settings: business details, numbering, backup
   ========================================================================= */
const settingFields = ['businessName', 'gstin', 'businessAddress', 'businessPhone', 'businessEmail', 'state', 'stateCode', 'bankDetails', 'terms', 'invoicePrefix', 'invoiceStart', 'invoiceDigits'];
function renderSignatureSetting() {
  const sign = S().settings?.signature;
  $('signaturePreview').innerHTML = sign ? `<img src="${sign}" alt="Your signature">` : 'No signature yet';
  $('removeSignature').hidden = !sign;
  $('uploadSignature').textContent = sign ? 'Change signature' : 'Upload signature';
}
async function saveSignature(signature, message) {
  try {
    await store.saveSettings({ ...S().settings, signature });
    $('signatureStatus').textContent = `${message} (saved ${store.where}).`;
    renderSignatureSetting(); renderPreview();
  } catch (error) { $('signatureStatus').textContent = `Could not save the signature: ${error.message || error}`; }
}
$('uploadSignature').onclick = () => $('signatureFile').click();
$('signatureFile').addEventListener('change', async () => {
  const file = $('signatureFile').files[0]; $('signatureFile').value = ''; if (!file) return;
  $('signatureStatus').textContent = 'Preparing signature…';
  try { await saveSignature(await signatureFromFile(file), 'Signature added. It now appears on bills'); }
  catch (error) { $('signatureStatus').textContent = error.message || String(error); }
});
$('removeSignature').onclick = async () => {
  if (!await confirmBox('Remove signature?', 'Bills and PDFs will no longer show your signature.', 'Remove', true)) return;
  await saveSignature('', 'Signature removed');
};
/* ---------- second shop (no GST) ---------- */
const secondFields = { s2Name: 'businessName', s2Phone: 'businessPhone', s2Address: 'businessAddress', s2Email: 'businessEmail', s2Bank: 'bankDetails', s2Terms: 'terms', s2Prefix: 'invoicePrefix', s2Start: 'invoiceStart', s2Digits: 'invoiceDigits' };
function fillSecondShopForm(second) {
  Object.entries(secondFields).forEach(([id, k]) => { $(id).value = second[k] ?? ''; });
  $('s2Enabled').checked = second.enabled; secondShopExample();
}
function secondShopExample() {
  $('s2Fields').hidden = !$('s2Enabled').checked;
  $('s2NumberExample').textContent = `Format: ${formatInvoiceNo({ invoicePrefix: $('s2Prefix').value, invoiceDigits: $('s2Digits').value }, financialYear(today()), Math.max(1, Number($('s2Start').value) || 1))}. Numbering is separate from the main shop and restarts every financial year (April).`;
}
$('secondShopForm').addEventListener('input', secondShopExample);
$('secondShopForm').addEventListener('submit', async e => {
  e.preventDefault();
  const wasEnabled = secondEnabled(), second = { ...S().settings.second, enabled: $('s2Enabled').checked };
  Object.entries(secondFields).forEach(([id, k]) => { second[k] = $(id).value; });
  try { await store.saveSettings({ ...S().settings, second }); }
  catch (error) { $('s2Status').textContent = `Could not save: ${error.message || error}`; return; }
  document.activeElement?.blur(); fillSettingsForm();
  $('s2Status').textContent = !second.enabled ? 'Second shop switched off. Its bills are kept, and come back if you switch it on again.'
    : `Saved ${store.where}.${wasEnabled ? '' : ' Tap the shop name at the top left to switch between your shops.'}`;
});

/* ---------- settings pages: a menu on the left (computer) or the Menu screen (phone) opens one page at a time ---------- */
const SETTINGS_TITLES = { business: 'Business & invoice', finance: 'Finance companies', sync: 'Sign-in, sync & staff', second: 'Second shop', signature: 'Signature', backup: 'Backup & restore', app: 'App version' };
let settingsSection = 'business';
function showSettings(section) { if (SETTINGS_TITLES[section]) settingsSection = section; show('settings'); }
function renderSettings() {
  document.querySelectorAll('.settings-page').forEach(p => { p.hidden = p.dataset.section !== settingsSection; });
  document.querySelectorAll('#settingsMenu [data-section]').forEach(b => b.classList.toggle('active', b.dataset.section === settingsSection));
  $('settingsTitle').textContent = isPhone() ? SETTINGS_TITLES[settingsSection] : 'Settings';
  if (settingsSection === 'sync') renderCloudPanel();
  if (settingsSection === 'app') renderAppPanel();
}
$('settingsMenu').addEventListener('click', e => { const section = e.target.closest('[data-section]')?.dataset.section; if (section) { settingsSection = section; renderSettings(); } });
$('settingsBack').onclick = () => show('menu');

/* ---------- finance companies (EMI) ---------- */
let financeDirty = false; // edited in Settings but not saved yet: don't overwrite with synced changes
const emiDayOptions = day => Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${i + 1 === Number(day) ? 'selected' : ''}>${ordinal(i + 1)}</option>`).join('');
function renderFinanceSettings(list = financeList()) {
  $('financeList').innerHTML = list.length ? list.map(f => `<div class="finance-item" data-id="${esc(f.id)}">
      <div class="form-grid">
        <label>Name<input class="fin-name" maxlength="40" value="${esc(f.name)}" placeholder="e.g. HDB Financial"></label>
        <label>EMI date<span class="req">Of every month</span><select class="fin-day">${emiDayOptions(f.emiDay)}</select></label>
        <label class="wide">Narration template<textarea class="fin-template" rows="5" maxlength="${NARRATION_MAX}">${esc(f.template)}</textarea></label>
      </div>
      <div class="row-actions"><button type="button" class="secondary small" data-fin="default">Use default text</button><button type="button" class="secondary small" data-fin="remove">Remove</button></div>
    </div>`).join('') : '<p class="hint">No finance companies. Add one to offer EMI on bills.</p>';
  $('financeAdd').disabled = list.length >= MAX_FINANCES;
}
const readFinanceSettings = () => [...$('financeList').querySelectorAll('.finance-item')].map(el => ({ id: el.dataset.id, name: el.querySelector('.fin-name').value, emiDay: el.querySelector('.fin-day').value, template: el.querySelector('.fin-template').value }));
function financeEdited(message = 'Not saved yet. Press "Save finance companies".') { financeDirty = true; $('financeStatus').textContent = message; }
$('financeForm').addEventListener('input', () => financeEdited());
$('financeAdd').onclick = () => {
  const list = readFinanceSettings(); list.push({ id: '', name: '', emiDay: 3, template: FINANCE_TEMPLATE });
  renderFinanceSettings(list); financeEdited(); $('financeList').lastElementChild.querySelector('.fin-name').focus();
};
$('financeList').addEventListener('click', e => {
  const btn = e.target.closest('[data-fin]'); if (!btn) return;
  const item = btn.closest('.finance-item');
  if (btn.dataset.fin === 'default') item.querySelector('.fin-template').value = FINANCE_TEMPLATE;
  if (btn.dataset.fin === 'remove') { const list = readFinanceSettings(); list.splice([...$('financeList').children].indexOf(item), 1); renderFinanceSettings(list); }
  financeEdited(btn.dataset.fin === 'remove' ? 'Removed. Press "Save finance companies" to keep this change. Old bills keep their finance details.' : undefined);
});
$('financeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const typed = readFinanceSettings(), finances = cleanFinances(typed);
  if (typed.some(f => !f.name.trim())) { $('financeStatus').textContent = 'Give every finance company a name (or remove the empty one).'; return; }
  try { await store.saveSettings({ ...S().settings, finances }); }
  catch (error) { $('financeStatus').textContent = `Could not save: ${error.message || error}`; return; }
  financeDirty = false; document.activeElement?.blur(); renderFinanceSettings();
  $('financeStatus').textContent = `Saved ${store.where}. ${finances.length} finance compan${finances.length === 1 ? 'y' : 'ies'}.`;
});

function fillSettingsForm() {
  const s = S().settings; if (!s) return;
  renderSignatureSetting();
  if (!financeDirty && !document.activeElement?.closest('#financeForm')) renderFinanceSettings();
  if (!document.activeElement?.closest('#secondShopForm')) fillSecondShopForm(s.second);
  if (document.activeElement?.closest('#businessForm')) return; // don't overwrite while typing
  settingFields.forEach(k => { $(k).value = s[k] ?? ''; }); $('roundUp').checked = s.roundUp; numberExample();
}
function numberExample() { const s = { invoicePrefix: $('invoicePrefix').value, invoiceDigits: $('invoiceDigits').value }; $('numberExample').textContent = `Format: ${formatInvoiceNo(s, financialYear(today()), Math.max(1, Number($('invoiceStart').value) || 1))}. Numbering restarts every financial year (April); "Start from" only matters if it is higher than the last number used.`; }
$('businessForm').addEventListener('input', numberExample);
$('businessForm').addEventListener('submit', async e => {
  e.preventDefault();
  const s = { ...S().settings }; settingFields.forEach(k => { s[k] = $(k).value; }); s.roundUp = $('roundUp').checked;
  await store.saveSettings(s); $('settingsStatus').textContent = `Settings saved ${store.where}.`; document.activeElement?.blur(); fillSettingsForm(); refreshInvoiceNo();
});
$('exportBackup').onclick = async () => {
  const s = S(), payload = { app: 'mm-gst', version: 2, exportedAt: new Date().toISOString(), invoices: s.invoices, products: s.products, settings: { ...s.settings, counters: s.counters } };
  try { await saveFile(new TextEncoder().encode(JSON.stringify(payload, null, 2)), `mm-gst-backup-${today()}.json`, 'application/json'); $('backupStatus').textContent = `Backup of ${s.invoices.length} bills created.`; }
  catch (error) { $('backupStatus').textContent = `Could not export: ${error.message || error}`; }
};
$('importBackup').onclick = () => $('restoreFile').click();
$('restoreFile').addEventListener('change', async () => {
  const file = $('restoreFile').files[0]; $('restoreFile').value = ''; if (!file) return;
  try {
    const payload = JSON.parse(await file.text()), incoming = Array.isArray(payload.invoices) ? payload.invoices : [];
    const invoices = incoming.map(migrateInvoice).filter(Boolean), products = (payload.products || []).map(cleanProduct).filter(Boolean);
    if (!await confirmBox('Restore backup?', `This replaces everything ${store.where} with ${invoices.length} bills and ${products.length} products from the file.${incoming.length - invoices.length ? ` ${incoming.length - invoices.length} unreadable records will be skipped.` : ''}`, 'Restore', true)) return;
    const counters = payload.settings?.counters && typeof payload.settings.counters === 'object' ? payload.settings.counters : {};
    await store.replaceAll({ invoices, products, settings: cleanSettings(payload.settings), counters });
    $('backupStatus').textContent = `Restored ${invoices.length} bills.`; newInvoice();
  } catch (error) { $('backupStatus').textContent = `Could not restore: ${error.message || error}`; }
});

/* =========================================================================
   Google sign-in + sync
   ========================================================================= */
const syncText = { local: 'On this device', connecting: 'Connecting…', synced: 'Synced', syncing: 'Syncing…', offline: 'Offline — will sync', error: 'Sync problem' };
function setSync(state) { syncState = state; $('syncChip').dataset.state = state; $('syncChip').textContent = syncText[state] || state; if (currentView === 'settings') renderCloudPanel(); }
$('syncChip').onclick = () => showSettings('sync');
window.addEventListener('online', () => { if (store === cloudStore && syncState === 'offline') setSync('syncing'); });
window.addEventListener('offline', () => { if (store === cloudStore) setSync('offline'); });

function updateAccountUI() {
  const user = cloud?.user, signedIn = Boolean(user && store === cloudStore);
  $('signInBtn').hidden = !cloud || signedIn; $('accountBtn').hidden = !signedIn;
  if (signedIn) { $('accountName').textContent = (user.displayName || user.email || '').split(' ')[0]; $('accountPhoto').src = user.photoURL || ''; $('accountPhoto').hidden = !user.photoURL; }
}
$('accountBtn').onclick = () => showSettings('sync');
$('signInBtn').onclick = signIn;
async function signIn() {
  if (!cloud) { showSettings('sync'); return; }
  try { setSync('connecting'); await cloud.signIn(); }
  catch (error) { setSync(store === cloudStore ? 'synced' : 'local'); toast(friendlyError(error), 'error'); }
}
async function signOut() {
  if (!await confirmBox('Sign out?', `This device will stop syncing and free its device slot. Your bills stay safe in the cloud. While signed out, new bills are saved only ${localStore.where}.`, 'Sign out')) return;
  await cloud.signOut();
}

async function startCloud(user) {
  setSync('connecting');
  try {
    await cloud.resolveShop();
    await cloud.registerDevice();
  } catch (error) {
    if (error.code === 'device-limit') return deviceLimitDialog(error.devices);
    toast(friendlyError(error), 'error'); setSync('local'); await cloud.signOut({ releaseDevice: false }); return;
  }
  cloudStore?.destroy();
  cloudStore = new CloudStore({ invoices: [], products: [], settings: cleanSettings(), counters: {} }, kind => { if (store === cloudStore) onData(kind); }, cloud, onShop, onCloudSync);
  await cloudStore.init();
  store = cloudStore; onData('all'); updateAccountUI();
  if (!editing) newInvoice();
  toast(`Signed in as ${user.email}. Bills now sync across your devices.`);
  offerImport();
}
async function deviceLimitDialog(devices) {
  setSync('local');
  const html = `<h3>Device limit reached</h3><p>Your shop is already open on ${MAX_DEVICES} devices. Remove one to use this device instead.</p>
    <div class="device-list">${devices.map(d => `<div class="line"><span>${esc(d.name)}<small>${esc(d.email)} · last used ${new Date(d.lastSeen).toLocaleString('en-IN')}</small></span><button class="danger small" data-result="rm:${esc(d.id)}">Remove</button></div>`).join('')}</div>
    <div class="actions end"><button class="secondary" data-result="cancel">Cancel and sign out</button></div>`;
  const r = await dialog(html);
  if (r && r.startsWith('rm:')) {
    try { await cloud.removeDevice(r.slice(3)); return startCloud(cloud.user); }
    catch (error) { toast(friendlyError(error), 'error'); }
  }
  await cloud.signOut({ releaseDevice: false });
}
function onShop(data, notFromServer) {
  shop = data;
  if (!notFromServer && !cloud.signingOut && store === cloudStore && !data.devices?.[cloud.deviceId]) {
    toast('This device was removed from your shop on another device, so it has been signed out.', 'error');
    cloud.signOut({ releaseDevice: false });
    return;
  }
  if (currentView === 'settings') renderCloudPanel();
}
function onCloudSync(state, error) {
  if (state === 'error') {
    if (error?.code === 'permission-denied') { toast('Your access to this shop was removed. Signing out.', 'error'); cloud.signOut({ releaseDevice: false }); return; }
    toast(friendlyError(error), 'error'); setSync('error'); return;
  }
  setSync(state);
}
async function offerImport(force = false) {
  const key = `mm-imported-${cloud.shopId}`; let done = false; try { done = localStorage.getItem(key); } catch { /* ignore */ }
  const local = await localStore.readAll();
  if (!local.invoices.length && !local.products.length) { if (force) toast('There are no bills saved only on this device.'); return; }
  if (done && !force) return;
  const ok = await confirmBox('Copy bills from this device?', `${local.invoices.length} bills and ${local.products.length} products are saved only ${localStore.where}. Copy them into your synced shop so all devices can see them? Bills already in the shop are skipped.`, 'Copy to shop');
  try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
  if (!ok) return;
  try { const r = await cloudStore.importLocal(local); toast(`Copied ${r.added} bills${r.skipped ? `, ${r.skipped} were already there` : ''}${r.renamed ? `, ${r.renamed} renumbered with a -B suffix because the number was taken` : ''}.`); }
  catch (error) { toast(friendlyError(error), 'error'); }
}

function renderCloudPanel() {
  const p = $('cloudPanel');
  if (!cloud) {
    p.innerHTML = `<h3>Google sign-in &amp; sync</h3><p>Sign in with Google to keep bills in sync live on up to ${MAX_DEVICES} phones and computers, with an online backup.</p>
      <p class="hint">Cloud sync isn't switched on for this copy of the app yet. The shop owner (or whoever set up the app) needs to create a free Firebase project once and paste its settings into <code>public/firebase-config.js</code> — the README has step-by-step instructions. Until then, bills are saved ${esc(localStore.where)}.</p>`;
    return;
  }
  const user = cloud.user;
  if (!user || store !== cloudStore) {
    p.innerHTML = `<h3>Google sign-in &amp; sync</h3><p>Bills are currently saved only <strong>${esc(localStore.where)}</strong>.</p><p>Sign in with Google to sync bills live on up to ${MAX_DEVICES} devices. Sign in with the same Google account on each device, or the owner can add staff accounts.</p><div class="actions"><button type="button" id="cloudSignIn">Sign in with Google</button></div>`;
    $('cloudSignIn').onclick = signIn; return;
  }
  const devices = Object.entries(shop?.devices || {}).map(([id, d]) => ({ id, ...d })).sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  const owner = cloud.role === 'owner', members = shop?.members || [];
  p.innerHTML = `<h3>Google sign-in &amp; sync</h3>
    <div class="line"><span>Signed in as <strong>${esc(user.email)}</strong><small>${owner ? 'Shop owner' : `Staff in ${esc(shop?.ownerEmail || 'owner')}'s shop`} · ${esc(syncText[syncState])}</small></span><button type="button" class="secondary small" id="cloudSignOut">Sign out</button></div>
    ${owner ? `<label class="inline-field">Shop name<span class="row-inline"><input id="shopName" maxlength="80" value="${esc(shop?.name || '')}"><button type="button" class="secondary small" id="shopNameSave">Save</button></span></label>` : ''}
    ${cloud.shops?.length > 1 ? `<label class="inline-field">Switch shop<select id="shopSwitch">${cloud.shops.map(s => `<option value="${esc(s.id)}" ${s.id === cloud.shopId ? 'selected' : ''}>${esc(s.name || s.ownerEmail)} (${s.role})</option>`).join('')}</select></label>` : ''}
    <h4>Devices using this shop (${devices.length} of ${MAX_DEVICES})</h4>
    <div class="device-list">${devices.map(d => `<div class="line"><span>${esc(d.name)}${d.id === cloud.deviceId ? ' <span class="badge paid">This device</span>' : ''}<small>${esc(d.email)} · last opened ${d.lastSeen ? new Date(d.lastSeen).toLocaleString('en-IN') : '—'}</small></span>${d.id === cloud.deviceId ? '' : `<button type="button" class="secondary small" data-rmdev="${esc(d.id)}">Remove</button>`}</div>`).join('')}</div>
    <p class="hint">Removing a device signs it out and frees its slot for another phone or computer.</p>
    ${owner ? `<h4>Staff accounts (${members.length} of ${MAX_STAFF})</h4>
      <div class="device-list">${members.map(m => `<div class="line"><span>${esc(m)}</span><button type="button" class="secondary small" data-rmstaff="${esc(m)}">Remove</button></div>`).join('') || '<p class="hint">Only you. Add a staff member\'s Gmail address to let them sign in with their own Google account. They count toward the device limit.</p>'}</div>
      <div class="row-inline"><input id="staffEmail" type="email" placeholder="staff@gmail.com"><button type="button" class="secondary small" id="staffAdd">Add staff</button></div>` : ''}
    <h4>Bills saved only on this device</h4>
    <div class="actions"><button type="button" class="secondary small" id="cloudImport">Copy this device's offline bills into the shop</button></div>`;
  $('cloudSignOut').onclick = signOut;
  $('cloudImport').onclick = () => offerImport(true);
  $('shopNameSave')?.addEventListener('click', async () => { try { await cloud.renameShop($('shopName').value); toast('Shop name saved.'); } catch (e) { toast(friendlyError(e), 'error'); } });
  $('shopSwitch')?.addEventListener('change', async e => { cloud.switchShop(e.target.value); toast('Switching shop…'); cloudStore?.destroy(); await startCloud(cloud.user); });
  $('staffAdd')?.addEventListener('click', async () => { try { await cloud.addStaff($('staffEmail').value, shop); toast('Staff added. They can now sign in with Google on their device.'); } catch (e) { toast(friendlyError(e), 'error'); } });
  p.querySelectorAll('[data-rmstaff]').forEach(b => b.addEventListener('click', async () => { if (await confirmBox('Remove staff?', `${b.dataset.rmstaff} will lose access and their devices will be signed out.`, 'Remove', true)) { try { await cloud.removeStaff(b.dataset.rmstaff, shop); } catch (e) { toast(friendlyError(e), 'error'); } } }));
  p.querySelectorAll('[data-rmdev]').forEach(b => b.addEventListener('click', async () => { if (await confirmBox('Remove device?', 'That device will be signed out and its slot freed.', 'Remove', true)) { try { await cloud.removeDevice(b.dataset.rmdev); } catch (e) { toast(friendlyError(e), 'error'); } } }));
}

/* =========================================================================
   App updates (Android app): new versions come from the GitHub releases page
   ========================================================================= */
let pendingUpdate = null;
const UPDATE_CHECK_KEY = 'mm-update-checked', UPDATE_LATER_KEY = 'mm-update-later';
function renderAppPanel() {
  $('appVersion').textContent = APP_VERSION; $('menuVersion').textContent = pendingUpdate ? `Version ${APP_VERSION} · update ${pendingUpdate.version} ready` : `Version ${APP_VERSION}`;
  if (isNativeApp()) {
    $('appActions').innerHTML = pendingUpdate ? `<button type="button" id="updateNow">Update to ${esc(pendingUpdate.version)}</button>` : '<button type="button" class="secondary" id="checkUpdate">Check for updates</button>';
    $('appHint').textContent = 'The app checks for a new version each time it opens, and offers to download and install it.';
  } else {
    $('appActions').innerHTML = `<a class="button secondary" href="${RELEASES_PAGE}" target="_blank" rel="noopener">Download the Android app</a>`;
    $('appHint').textContent = 'This is the web version. It is always up to date when the website is updated.';
  }
  $('checkUpdate')?.addEventListener('click', () => checkForUpdate({ manual: true }));
  $('updateNow')?.addEventListener('click', () => updateDialog(pendingUpdate));
}
function renderUpdateBanner() {
  let later = ''; try { later = sessionStorage.getItem(UPDATE_LATER_KEY) || ''; } catch { /* ignore */ }
  const b = $('updateBanner');
  if (!pendingUpdate || later === pendingUpdate.version) { b.hidden = true; return; }
  b.innerHTML = `<span>🔔 A new version of the app (<strong>${esc(pendingUpdate.version)}</strong>) is ready.</span><span class="spacer"></span><button type="button" class="small" id="updateOpen">Update</button><button type="button" class="secondary small" id="updateLater">Later</button>`;
  b.hidden = false;
  $('updateOpen').onclick = () => updateDialog(pendingUpdate);
  $('updateLater').onclick = () => { try { sessionStorage.setItem(UPDATE_LATER_KEY, pendingUpdate.version); } catch { /* ignore */ } b.hidden = true; };
}
async function checkForUpdate({ manual = false } = {}) {
  if (!isNativeApp()) return;
  if (manual) $('updateStatus').textContent = 'Checking for updates…';
  try {
    pendingUpdate = await findUpdate();
    try { localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now())); } catch { /* ignore */ }
    if (manual) $('updateStatus').textContent = pendingUpdate ? `Version ${pendingUpdate.version} is available.` : `You have the latest version (${APP_VERSION}).`;
    if (!pendingUpdate) removeDownloadedApk();
    renderUpdateBanner(); renderAppPanel();
    if (manual && pendingUpdate) updateDialog(pendingUpdate);
  } catch (error) {
    if (manual) $('updateStatus').textContent = `Could not check for updates: ${error.message || error}`;
    else console.warn('Update check failed', error);
  }
}
// Quietly check on start, and again when the app comes back to the screen after a few hours.
function checkForUpdateIfDue(minHours) {
  let last = 0; try { last = Number(localStorage.getItem(UPDATE_CHECK_KEY)) || 0; } catch { /* ignore */ }
  if (Date.now() - last >= minHours * 3600000) checkForUpdate();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isNativeApp()) checkForUpdateIfDue(6); });
async function updateDialog(release) {
  if (!release) return;
  const size = release.apk.size ? ` (${(release.apk.size / 1048576).toFixed(1)} MB)` : '';
  const notes = plainNotes(release.notes);
  await dialog(`<h3>Update to version ${esc(release.version)}</h3>
    <p>You have version ${esc(APP_VERSION)}. Your bills are kept: the update installs over this app.</p>
    ${notes ? `<div class="update-notes">${esc(notes)}</div>` : ''}
    <div id="updProgress" hidden><div class="progress"><span id="updBar"></span></div><p class="hint" id="updText">Downloading…</p></div>
    <p class="hint">Android will ask you to confirm. If it asks, allow this app to install apps, then go back and tap Update.</p>
    <div class="actions end"><button class="secondary" data-result="close">Later</button><button class="secondary" id="updBrowser" hidden>Download in browser</button><button id="updGo">Download and install${size}</button></div>`, (body, done) => {
    const go = body.querySelector('#updGo'), text = body.querySelector('#updText'), bar = body.querySelector('#updBar');
    let downloaded = null; // path of the downloaded APK, so "Open installer again" doesn't download it again
    body.querySelector('#updBrowser').addEventListener('click', e => { e.preventDefault(); window.open(release.apk.url, '_blank'); done('browser'); });
    go.addEventListener('click', async e => {
      e.preventDefault();
      if (downloaded) { openInstaller(downloaded).catch(error => { text.textContent = String(error.message || error); }); return; }
      go.disabled = true; go.textContent = 'Downloading…';
      body.querySelector('#updProgress').hidden = false;
      try {
        downloaded = await downloadAndInstall(release, f => { bar.style.width = `${Math.round(f * 100)}%`; text.textContent = `Downloading… ${Math.round(f * 100)}%`; });
        text.textContent = 'Downloaded. Android\'s installer is open: tap Update (or Install).';
        go.textContent = 'Open installer again'; go.disabled = false;
      } catch (error) {
        text.textContent = `${error.message || error} You can also download it in the browser and open the downloaded file.`;
        go.textContent = 'Try again'; go.disabled = false; body.querySelector('#updBrowser').hidden = false;
      }
    });
  });
}

/* =========================================================================
   Start up
   ========================================================================= */
async function boot() {
  await localStore.init();
  newInvoice(); show('dashboard'); renderAppPanel();
  if (isNativeApp()) setTimeout(() => checkForUpdateIfDue(1), 3000);
  const config = window.MM_FIREBASE_CONFIG;
  if (config && config.apiKey && config.projectId) {
    try {
      cloud = new Cloud(config); cloud.onError = msg => toast(msg, 'error');
      await cloud.load();
      updateAccountUI();
      cloud.onAuthChange(async user => {
        if (user) { await startCloud(user); }
        else { cloudStore?.destroy(); cloudStore = null; shop = null; if (store !== localStore) { store = localStore; editing = null; onData('all'); newInvoice(); } setSync('local'); }
        updateAccountUI(); if (currentView === 'settings') renderCloudPanel();
      });
    } catch (error) {
      cloud = null; console.warn('Cloud sync unavailable', error);
      toast('Could not load Google sign-in (are you offline?). Bills are being saved on this device.', 'error');
    }
  }
  updateAccountUI();
}
boot();
