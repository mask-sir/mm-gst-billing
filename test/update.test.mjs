// App update checks against GitHub releases. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseVersion, plainNotes, findUpdate } from '../public/js/update.js';
import { APP_VERSION } from '../public/js/version.js';
import { readFileSync } from 'node:fs';

test('version comparison', () => {
  assert.deepEqual(parseVersion('v2.10.3'), [2, 10, 3]);
  assert.equal(parseVersion('latest'), null);
  assert.ok(isNewer('v2.2.1', '2.2.0')); assert.ok(isNewer('2.10.0', '2.9.9')); assert.ok(isNewer('v3.0', '2.99.99'));
  assert.ok(!isNewer('v2.2.0', '2.2.0')); assert.ok(!isNewer('v2.1.9', '2.2.0')); assert.ok(!isNewer('nightly', '2.2.0'));
});
test('app version matches package.json and build.gradle', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  const [maj, min, patch] = parseVersion(APP_VERSION);
  assert.equal(pkg.version, APP_VERSION);
  assert.match(gradle, new RegExp(`versionName "${APP_VERSION.replace(/\./g, '\\.')}"`));
  assert.match(gradle, new RegExp(`versionCode ${maj * 10000 + min * 100 + patch}\\b`));
});
test('release notes lose their Markdown', () => {
  assert.equal(plainNotes('## What\'s new\r\n- **Finance** on bills\n* [Link](http://x)\n\n\n\n`code`'), "What's new\n• Finance on bills\n• Link\n\ncode");
});
test('only a newer release with an APK counts as an update', async () => {
  const reply = release => async () => ({ ok: true, status: 200, json: async () => release });
  const apk = { name: 'MM-GST-Billing-v9.0.0.apk', browser_download_url: 'https://example.com/a.apk', size: 10, state: 'uploaded' };
  globalThis.fetch = reply({ tag_name: 'v9.0.0', body: 'notes', assets: [apk] });
  const u = await findUpdate();
  assert.equal(u.version, '9.0.0'); assert.equal(u.apk.url, apk.browser_download_url);
  globalThis.fetch = reply({ tag_name: 'v9.0.0', assets: [] });
  assert.equal(await findUpdate(), null, 'APK not attached yet');
  globalThis.fetch = reply({ tag_name: `v${APP_VERSION}`, assets: [apk] });
  assert.equal(await findUpdate(), null, 'same version');
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  assert.equal(await findUpdate(), null, 'no releases yet');
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(findUpdate(), /too many update checks/);
});
