// Local (this device only) storage. Used when nobody is signed in.
//  - Android app: Capacitor Preferences (same keys as earlier versions, so old bills are kept)
//  - Desktop with `npm start`: the local Node server's data/ folder (same files as earlier versions)
//  - Any other browser: localStorage
import { migrateInvoice, cleanProduct, cleanSettings, financialYear, formatInvoiceNo, nextCounter, uid, profileOf, profileSettings, counterKey } from './util.js';

const KEYS = { invoices: 'mm-gst-invoices', products: 'mm-gst-products', settings: 'mm-gst-settings', counters: 'mm-gst-counters' };
const prefs = window.Capacitor?.Plugins?.Preferences;
const isNative = Boolean(window.Capacitor?.isNativePlatform?.());

async function detectServer() {
  if (isNative || location.protocol === 'file:') return false;
  try { const r = await fetch('/api/store/settings', { cache: 'no-store' }); return r.ok && (r.headers.get('content-type') || '').includes('json'); } catch { return false; }
}

export class LocalStore {
  constructor(state, onChange) { this.state = state; this.onChange = onChange; this.kind = 'local'; }

  async init() {
    this.useServer = await detectServer();
    this.where = isNative ? 'on this phone' : this.useServer ? 'on this computer' : 'in this browser';
    const [invoices, products, settings, counters] = await Promise.all(['invoices', 'products', 'settings', 'counters'].map(k => this.get(k)));
    this.state.invoices = (Array.isArray(invoices) ? invoices : []).map(migrateInvoice).filter(Boolean);
    this.state.products = (Array.isArray(products) ? products : []).map(cleanProduct).filter(Boolean);
    this.state.settings = cleanSettings(settings);
    this.state.counters = counters && typeof counters === 'object' ? counters : {};
    this.onChange('all');
  }
  async get(key) {
    try {
      if (isNative && prefs) { const v = (await prefs.get({ key: KEYS[key] })).value; return v ? JSON.parse(v) : null; }
      if (this.useServer) { const r = await fetch(`/api/store/${key}`, { cache: 'no-store' }); return r.ok ? await r.json() : null; }
      const v = localStorage.getItem(KEYS[key]); return v ? JSON.parse(v) : null;
    } catch { return null; }
  }
  async set(key, value) {
    if (isNative && prefs) return prefs.set({ key: KEYS[key], value: JSON.stringify(value) });
    if (this.useServer) {
      const r = await fetch(`/api/store/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save on this computer.');
      return;
    }
    localStorage.setItem(KEYS[key], JSON.stringify(value));
  }

  async createInvoice(invoice) {
    const profile = profileOf(invoice), shop = profileSettings(this.state.settings, profile);
    const year = financialYear(invoice.date), counter = nextCounter(this.state.counters, this.state.invoices, year, shop, profile);
    const now = new Date().toISOString();
    const saved = { ...invoice, id: invoice.id || `inv_${uid()}`, invoiceNo: formatInvoiceNo(shop, year, counter), createdAt: now, updatedAt: now };
    const counters = { ...this.state.counters, [counterKey(profile, year)]: counter };
    await this.set('invoices', [saved, ...this.state.invoices]);
    await this.set('counters', counters);
    this.state.invoices = [saved, ...this.state.invoices]; this.state.counters = counters;
    this.onChange('invoices');
    return saved;
  }
  async updateInvoice(invoice) {
    const saved = { ...invoice, updatedAt: new Date().toISOString() };
    const list = this.state.invoices.map(i => i.id === saved.id ? saved : i);
    await this.set('invoices', list); this.state.invoices = list; this.onChange('invoices');
    return saved;
  }
  async saveProduct(product) {
    const saved = { ...product, updatedAt: new Date().toISOString() };
    const exists = this.state.products.some(p => p.id === saved.id);
    const list = exists ? this.state.products.map(p => p.id === saved.id ? saved : p) : [...this.state.products, saved];
    await this.set('products', list); this.state.products = list; this.onChange('products');
    return saved;
  }
  async deleteProduct(id) {
    const list = this.state.products.filter(p => p.id !== id);
    await this.set('products', list); this.state.products = list; this.onChange('products');
  }
  async saveSettings(settings) {
    const clean = cleanSettings(settings);
    await this.set('settings', clean); this.state.settings = clean; this.onChange('settings');
  }
  async replaceAll({ invoices, products, settings, counters }) {
    await this.set('invoices', invoices); await this.set('products', products); await this.set('settings', settings); await this.set('counters', counters);
    Object.assign(this.state, { invoices, products, settings, counters }); this.onChange('all');
  }
  async readAll() {
    // Fresh read straight from storage (used to copy this device's bills into the cloud after signing in).
    const [invoices, products, settings, counters] = await Promise.all(['invoices', 'products', 'settings', 'counters'].map(k => this.get(k)));
    return {
      invoices: (Array.isArray(invoices) ? invoices : []).map(migrateInvoice).filter(Boolean),
      products: (Array.isArray(products) ? products : []).map(cleanProduct).filter(Boolean),
      settings: settings ? cleanSettings(settings) : null, counters: counters && typeof counters === 'object' ? counters : {}
    };
  }
  destroy() {}
}
