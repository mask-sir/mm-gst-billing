// App updates for the Android app. Each new version is published as a GitHub release with the APK attached
// (built by .github/workflows/release-apk.yml). The app asks GitHub for the latest release and, if it is newer,
// downloads the APK and opens Android's installer. Android always asks the user to confirm the install.
import { APP_VERSION } from './version.js';

export const REPO = 'mask-sir/mm-gst-billing';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const APK_FILE = 'MM-GST-Billing-update.apk'; // in the app's cache folder; replaced by each download
export const isNativeApp = () => Boolean(window.Capacitor?.isNativePlatform?.());

export function parseVersion(value) {
  const m = String(value || '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
export function isNewer(candidate, current = APP_VERSION) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The latest published release (drafts and pre-releases are skipped by GitHub), or null if there is none yet.
export async function latestRelease({ timeout = 15000 } = {}) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: ctrl.signal });
    if (r.status === 404) return null;
    if (r.status === 403 || r.status === 429) throw new Error('GitHub has had too many update checks from this internet connection. Try again in an hour.');
    if (!r.ok) throw new Error(`GitHub replied with an error (${r.status}). Try again later.`);
    const rel = await r.json();
    const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name || '') && (a.state || 'uploaded') === 'uploaded');
    return {
      version: String(rel.tag_name || '').replace(/^v/i, ''), name: rel.name || rel.tag_name || '', notes: String(rel.body || ''),
      page: rel.html_url || RELEASES_PAGE, publishedAt: rel.published_at || '',
      apk: apk ? { name: apk.name, url: apk.browser_download_url, size: Number(apk.size) || 0 } : null
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('GitHub did not answer. Check the internet connection and try again.');
    if (error instanceof TypeError) throw new Error('Could not reach GitHub. Check the internet connection and try again.');
    throw error;
  } finally { clearTimeout(timer); }
}

// The release to update to, or null when this app is up to date. A release only counts once its APK is attached
// (the GitHub build takes a few minutes after the release is published).
export async function findUpdate() {
  const rel = await latestRelease();
  return rel && rel.apk && isNewer(rel.version) ? rel : null;
}

// Release notes as plain text: GitHub's Markdown without the symbols.
export function plainNotes(markdown) {
  return String(markdown || '').replace(/\r/g, '').replace(/^#{1,6}\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*[-*]\s+/gm, '• ').replace(/\n{3,}/g, '\n\n').trim();
}

// Android app: download the APK into the app's cache folder, then open Android's installer on it.
// onProgress(fraction 0..1) is called while downloading.
export async function downloadAndInstall(release, onProgress) {
  const fs = window.Capacitor?.Plugins?.Filesystem, opener = window.Capacitor?.Plugins?.FileOpener;
  if (!isNativeApp() || !fs?.downloadFile || !opener?.open) throw new Error('This copy of the app cannot install updates by itself.');
  let listener = null;
  try {
    if (onProgress && fs.addListener) listener = await fs.addListener('progress', p => { if (p?.contentLength > 0) onProgress(Math.min(1, p.bytes / p.contentLength)); });
    const result = await fs.downloadFile({ url: release.apk.url, path: APK_FILE, directory: 'CACHE', progress: Boolean(onProgress), connectTimeout: 20000, readTimeout: 60000 });
    if (!result?.path) throw new Error('The download did not finish.');
    if (release.apk.size) {
      const info = await fs.stat({ path: APK_FILE, directory: 'CACHE' }).catch(() => null);
      if (info && Number(info.size) !== release.apk.size) throw new Error('The download was incomplete. Check the internet connection and try again.');
    }
    onProgress?.(1);
    await openInstaller(result.path);
    return result.path;
  } finally {
    try { await listener?.remove(); } catch { /* ignore */ }
  }
}

// Opens Android's installer on a downloaded APK.
export async function openInstaller(path) {
  await window.Capacitor.Plugins.FileOpener.open({ filePath: path, contentType: 'application/vnd.android.package-archive', openWithDefault: true });
}

// After an update the old download is no longer needed.
export async function removeDownloadedApk() {
  try { await window.Capacitor?.Plugins?.Filesystem?.deleteFile({ path: APK_FILE, directory: 'CACHE' }); } catch { /* not there */ }
}
