// Google sign-in + live sync through Firebase (Authentication + Cloud Firestore).
//
// Data layout in Firestore (see firestore.rules):
//   shops/{ownerUid}                    { name, ownerUid, ownerEmail, members: [emails], devices: { deviceId: {...} } }
//   shops/{ownerUid}/invoices/{id}      one document per bill
//   shops/{ownerUid}/products/{id}      product catalogue
//   shops/{ownerUid}/meta/settings      business details + invoice number format
//   shops/{ownerUid}/meta/counters      { counters: { "26-27": 42 } } — updated in a transaction so two
//                                        devices can never hand out the same invoice number
//
// One shop can be used from at most MAX_DEVICES devices at the same time. The owner can also let
// staff sign in with their own Google accounts (Settings → Cloud sync → Staff).
import { migrateInvoice, cleanProduct, cleanSettings, financialYear, formatInvoiceNo, nextCounter, deviceLabel, getDeviceId, uid, profileOf, profileSettings, counterKey } from './util.js';

export const MAX_DEVICES = 3;
export const MAX_STAFF = 4;
const SDK = 'https://www.gstatic.com/firebasejs/11.10.0';
const isNative = Boolean(window.Capacitor?.isNativePlatform?.());

export class DeviceLimitError extends Error {
  constructor(devices) { super(`This shop is already open on ${MAX_DEVICES} devices.`); this.devices = devices; this.code = 'device-limit'; }
}

function friendlyError(error) {
  const code = error?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was cancelled.';
  if (code === 'auth/unauthorized-domain') return `This web address (${location.hostname}) is not allowed to sign in yet. Add it under Firebase console → Authentication → Settings → Authorized domains.`;
  if (code === 'auth/network-request-failed' || code === 'unavailable') return 'No internet connection. Connect and try again.';
  if (code === 'permission-denied') return 'Your Google account does not have access to this shop.';
  const message = String(error?.message || error);
  if (/no credential/i.test(message)) return 'No Google account was found on this phone. Add one in the phone\'s Settings → Accounts, then try again.';
  if (/^10:|DEVELOPER_ERROR/.test(message)) return 'Google sign-in is not set up for this copy of the app (its signing key is not registered in Firebase). See README → Android.';
  if (/^12501:|cancel/i.test(message)) return 'Sign-in was cancelled.';
  return error?.message || String(error);
}
export { friendlyError };

export class Cloud {
  constructor(config) { this.config = config; this.deviceId = getDeviceId(); this.user = null; }

  async load() {
    const [appMod, authMod, fsMod] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)]);
    this.fb = { ...authMod, ...fsMod };
    const app = appMod.initializeApp(this.config);
    // Inside the Android app the default popup/redirect helpers don't exist, so use plain IndexedDB persistence there.
    this.auth = isNative ? authMod.initializeAuth(app, { persistence: authMod.indexedDBLocalPersistence }) : authMod.getAuth(app);
    let localCache;
    try { localCache = fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }); } catch { localCache = undefined; }
    this.db = fsMod.initializeFirestore(app, { ignoreUndefinedProperties: true, ...(localCache ? { localCache } : {}) });
    // For development with `firebase emulators:start`: add  emulators: { host: '127.0.0.1' }  to the config.
    if (this.config.emulators) {
      const host = this.config.emulators.host || '127.0.0.1';
      authMod.connectAuthEmulator(this.auth, `http://${host}:${this.config.emulators.authPort || 9099}`, { disableWarnings: true });
      fsMod.connectFirestoreEmulator(this.db, host, this.config.emulators.firestorePort || 8080);
    }
    if (!isNative) this.fb.getRedirectResult(this.auth).catch(e => this.onError?.(friendlyError(e)));
  }
  onAuthChange(callback) { return this.fb.onAuthStateChanged(this.auth, user => { this.user = user; callback(user); }); }

  async signIn() {
    const { GoogleAuthProvider, signInWithPopup, signInWithRedirect, signInWithCredential } = this.fb;
    const nativeAuth = window.Capacitor?.Plugins?.FirebaseAuthentication;
    if (isNative) {
      if (!nativeAuth) throw new Error('Google sign-in needs the @capacitor-firebase/authentication plugin in the Android app. See README → Android.');
      let result;
      try { result = await nativeAuth.signInWithGoogle({ skipNativeAuth: true }); }
      catch (error) {
        // Android's Credential Manager says "No credentials available" on some phones even when a Google account is
        // present (older Play services, some phone brands). Fall back to the classic Google account picker.
        if (!/no credential/i.test(String(error?.message || error))) throw error;
        result = await nativeAuth.signInWithGoogle({ skipNativeAuth: true, useCredentialManager: false });
      }
      const credential = GoogleAuthProvider.credential(result.credential?.idToken || null, result.credential?.accessToken || null);
      return signInWithCredential(this.auth, credential);
    }
    const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' });
    try { return await signInWithPopup(this.auth, provider); }
    catch (error) {
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) return signInWithRedirect(this.auth, provider);
      throw error;
    }
  }
  async signOut({ releaseDevice = true } = {}) {
    if (this.signingOut) return;
    this.signingOut = true;
    try { await this._signOut(releaseDevice); } finally { this.signingOut = false; }
  }
  async _signOut(releaseDevice) {
    if (releaseDevice && this.shopId) {
      // Wait (briefly) for the server to confirm the slot is freed. Offline, give up: it can be removed from another device.
      try { await Promise.race([this.removeDevice(this.deviceId), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))]); } catch { /* see above */ }
    }
    try { await window.Capacitor?.Plugins?.FirebaseAuthentication?.signOut?.(); } catch { /* ignore */ }
    this.shopId = null;
    await this.fb.signOut(this.auth);
  }

  /* ---------- which shop does this Google account belong to? ---------- */
  async resolveShop() {
    const { doc, getDoc, setDoc, collection, query, where, getDocs } = this.fb;
    const user = this.user, email = (user.email || '').toLowerCase();
    const ownRef = doc(this.db, 'shops', user.uid);
    const [ownSnap, memberSnap] = await Promise.all([
      getDoc(ownRef),
      email ? getDocs(query(collection(this.db, 'shops'), where('members', 'array-contains', email))) : Promise.resolve({ docs: [] })
    ]);
    const shops = [];
    if (ownSnap.exists()) shops.push({ id: ownSnap.id, ...ownSnap.data(), role: 'owner' });
    memberSnap.docs.forEach(d => { if (d.id !== user.uid) shops.push({ id: d.id, ...d.data(), role: 'staff' }); });
    let saved = null; try { saved = localStorage.getItem('mm-shop-id'); } catch { /* ignore */ }
    let chosen = shops.find(s => s.id === saved) || shops.find(s => s.role === 'staff') || shops.find(s => s.role === 'owner');
    if (!chosen) {
      const fresh = { name: 'My shop', ownerUid: user.uid, ownerEmail: email, members: [], devices: {}, createdAt: new Date().toISOString() };
      await setDoc(ownRef, fresh);
      chosen = { id: user.uid, ...fresh, role: 'owner' };
      shops.push(chosen);
    }
    this.shops = shops; this.shopId = chosen.id; this.role = chosen.role;
    try { localStorage.setItem('mm-shop-id', chosen.id); } catch { /* ignore */ }
    return chosen;
  }
  switchShop(id) { try { localStorage.setItem('mm-shop-id', id); } catch { /* ignore */ } }

  /* ---------- device slots ---------- */
  async registerDevice() {
    const { doc, runTransaction } = this.fb, ref = doc(this.db, 'shops', this.shopId);
    await runTransaction(this.db, async tx => {
      const snap = await tx.get(ref), devices = { ...(snap.data()?.devices || {}) }, now = new Date().toISOString();
      if (!devices[this.deviceId] && Object.keys(devices).length >= MAX_DEVICES) throw new DeviceLimitError(Object.entries(devices).map(([id, d]) => ({ id, ...d })));
      devices[this.deviceId] = { name: devices[this.deviceId]?.name || deviceLabel(), email: (this.user.email || '').toLowerCase(), addedAt: devices[this.deviceId]?.addedAt || now, lastSeen: now };
      tx.update(ref, { devices });
    });
  }
  async removeDevice(id) {
    const { doc, updateDoc, deleteField } = this.fb;
    await updateDoc(doc(this.db, 'shops', this.shopId), { [`devices.${id}`]: deleteField() });
  }
  async renameShop(name) { await this.fb.updateDoc(this.fb.doc(this.db, 'shops', this.shopId), { name: String(name).trim().slice(0, 80) || 'My shop' }); }
  async addStaff(email, current) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid Google email address.');
    if (email === (this.user.email || '').toLowerCase()) throw new Error('That is your own account.');
    if ((current.members || []).includes(email)) throw new Error('Already added.');
    if ((current.members || []).length >= MAX_STAFF) throw new Error(`You can add up to ${MAX_STAFF} staff accounts.`);
    await this.fb.updateDoc(this.fb.doc(this.db, 'shops', this.shopId), { members: this.fb.arrayUnion(email) });
  }
  async removeStaff(email, current) {
    // Removing a staff account also frees any device slots it was using.
    const devices = Object.fromEntries(Object.entries(current.devices || {}).filter(([, d]) => d.email !== email));
    await this.fb.updateDoc(this.fb.doc(this.db, 'shops', this.shopId), { members: this.fb.arrayRemove(email), devices });
  }
}

/* ---------- the synced data store (same interface as LocalStore) ---------- */
export class CloudStore {
  constructor(state, onChange, cloud, onShop, onSync) {
    Object.assign(this, { state, onChange, cloud, onShop, onSync });
    this.kind = 'cloud'; this.fb = cloud.fb; this.db = cloud.db; this.shopId = cloud.shopId; this.where = 'in your Google-synced shop';
    this.unsubs = []; this.pending = { invoices: false }; this.fromCache = {};
  }
  ref(...path) { return this.fb.doc(this.db, 'shops', this.shopId, ...path); }
  col(name) { return this.fb.collection(this.db, 'shops', this.shopId, name); }

  init() {
    const { onSnapshot } = this.fb;
    const ready = new Set(), need = ['shop', 'invoices', 'products', 'settings', 'counters'];
    let resolveReady; const whenReady = new Promise(r => { resolveReady = r; });
    const mark = name => { ready.add(name); if (need.every(n => ready.has(n))) resolveReady(); };
    const fail = error => { this.onSync('error', error); resolveReady(); };
    const track = (name, snap) => {
      this.fromCache[name] = snap.metadata.fromCache; this.pending[name] = snap.metadata.hasPendingWrites;
      const anyPending = Object.values(this.pending).some(Boolean), anyCache = Object.values(this.fromCache).some(Boolean);
      this.onSync(anyPending ? 'syncing' : anyCache && !navigator.onLine ? 'offline' : 'synced');
    };
    this.unsubs.push(onSnapshot(this.ref(), { includeMetadataChanges: true }, snap => { this.shop = { id: snap.id, ...snap.data() }; this.onShop(this.shop, snap.metadata.fromCache || snap.metadata.hasPendingWrites); mark('shop'); }, fail));
    this.unsubs.push(onSnapshot(this.col('invoices'), { includeMetadataChanges: true }, snap => {
      track('invoices', snap);
      this.state.invoices = snap.docs.map(d => migrateInvoice({ ...d.data(), id: d.id })).filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      this.onChange('invoices'); mark('invoices');
    }, fail));
    this.unsubs.push(onSnapshot(this.col('products'), { includeMetadataChanges: true }, snap => {
      track('products', snap);
      this.state.products = snap.docs.map(d => cleanProduct({ ...d.data(), id: d.id })).filter(Boolean);
      this.onChange('products'); mark('products');
    }, fail));
    this.unsubs.push(onSnapshot(this.ref('meta', 'settings'), snap => { this.settingsExist = snap.exists(); this.state.settings = cleanSettings(snap.data()); this.onChange('settings'); mark('settings'); }, fail));
    this.unsubs.push(onSnapshot(this.ref('meta', 'counters'), snap => { this.state.counters = snap.data()?.counters || {}; mark('counters'); }, fail));
    return whenReady;
  }

  async createInvoice(invoice) {
    const { runTransaction, doc } = this.fb;
    if (!navigator.onLine) throw new Error('You are offline. A new bill needs internet for a moment so that two devices never use the same invoice number.');
    const year = financialYear(invoice.date), countersRef = this.ref('meta', 'counters'), now = new Date().toISOString();
    const id = invoice.id || `inv_${uid()}`, invRef = doc(this.col('invoices'), id);
    const profile = profileOf(invoice), shop = profileSettings(this.state.settings, profile);
    let saved;
    await runTransaction(this.db, async tx => {
      const snap = await tx.get(countersRef), counters = snap.data()?.counters || {};
      const counter = nextCounter(counters, this.state.invoices, year, shop, profile);
      saved = { ...invoice, id, invoiceNo: formatInvoiceNo(shop, year, counter), createdAt: now, updatedAt: now, createdBy: (this.cloud.user?.email || '').toLowerCase() };
      tx.set(countersRef, { counters: { ...counters, [counterKey(profile, year)]: counter } });
      tx.set(invRef, saved);
    });
    return saved;
  }
  async updateInvoice(invoice) {
    const saved = { ...invoice, updatedAt: new Date().toISOString(), updatedBy: (this.cloud.user?.email || '').toLowerCase() };
    // Don't await the server: offline edits are queued by Firestore and sent when the connection is back.
    this.fb.setDoc(this.fb.doc(this.col('invoices'), saved.id), saved).catch(e => this.onSync('error', e));
    return saved;
  }
  async saveProduct(product) {
    const saved = { ...product, updatedAt: new Date().toISOString() };
    this.fb.setDoc(this.fb.doc(this.col('products'), saved.id), saved).catch(e => this.onSync('error', e));
    return saved;
  }
  async deleteProduct(id) { this.fb.deleteDoc(this.fb.doc(this.col('products'), id)).catch(e => this.onSync('error', e)); }
  async saveSettings(settings) { const clean = cleanSettings(settings); this.fb.setDoc(this.ref('meta', 'settings'), clean).catch(e => this.onSync('error', e)); this.state.settings = clean; this.onChange('settings'); }

  async writeInChunks(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = this.fb.writeBatch(this.db);
      ops.slice(i, i + 400).forEach(op => op(batch));
      await batch.commit();
    }
  }
  async replaceAll({ invoices, products, settings, counters }) {
    const { doc } = this.fb, ops = [];
    this.state.invoices.forEach(i => ops.push(b => b.delete(doc(this.col('invoices'), i.id))));
    this.state.products.forEach(p => ops.push(b => b.delete(doc(this.col('products'), p.id))));
    invoices.forEach(i => ops.push(b => b.set(doc(this.col('invoices'), i.id), i)));
    products.forEach(p => ops.push(b => b.set(doc(this.col('products'), p.id), p)));
    ops.push(b => b.set(this.ref('meta', 'settings'), settings));
    ops.push(b => b.set(this.ref('meta', 'counters'), { counters }));
    await this.writeInChunks(ops);
  }
  // Copy bills made while signed out (or before this update) into the shared shop. Bills already in the
  // cloud are skipped; a different bill that happens to reuse an existing number gets a "-B" suffix.
  async importLocal(local) {
    const { doc } = this.fb, ops = [];
    const byNo = new Map(this.state.invoices.map(i => [i.invoiceNo, i])), ids = new Set(this.state.invoices.map(i => i.id));
    let added = 0, skipped = 0, renamed = 0;
    for (const inv of local.invoices) {
      const existing = byNo.get(inv.invoiceNo);
      if (existing && existing.customer.name === inv.customer.name && existing.date === inv.date) { skipped++; continue; }
      let copy = { ...inv };
      if (existing) { let n = 0, no; do { no = `${inv.invoiceNo}-${String.fromCharCode(66 + n++)}`; } while (byNo.has(no)); copy.invoiceNo = no; renamed++; }
      if (ids.has(copy.id)) copy.id = `inv_${uid()}`;
      byNo.set(copy.invoiceNo, copy); ids.add(copy.id); added++;
      ops.push(b => b.set(doc(this.col('invoices'), copy.id), copy));
    }
    const productNames = new Set(this.state.products.map(p => p.name.toLowerCase()));
    local.products.filter(p => !productNames.has(p.name.toLowerCase())).forEach(p => ops.push(b => b.set(doc(this.col('products'), p.id), p)));
    if (!this.settingsExist && local.settings) ops.push(b => b.set(this.ref('meta', 'settings'), local.settings));
    const merged = { ...this.state.counters };
    for (const [y, c] of Object.entries(local.counters || {})) merged[y] = Math.max(Number(merged[y]) || 0, Number(c) || 0);
    ops.push(b => b.set(this.ref('meta', 'counters'), { counters: merged }));
    await this.writeInChunks(ops);
    return { added, skipped, renamed };
  }
  destroy() { this.unsubs.forEach(u => { try { u(); } catch { /* ignore */ } }); this.unsubs = []; }
}
