# MM GST Billing

GST billing software for MM Mobiles. It runs in a browser, as a desktop app (`npm start`) and as an Android app (Capacitor).
Sign in with Google to keep bills in sync live on up to **3 devices** (phones and computers) at the same time.

## Features

**Layout**: on a computer, a sidebar with *New sale*, Home, Bills, Customers, Items, Reports and Settings, and a search box for bills at the top. On a phone, a bottom bar with Home, Bills, a round **New sale** button, Items and **Menu** (Customers, Reports and every settings page). The new-sale screen has the customer, items, payment and narration in separate sections, a bar at the bottom with the total and **Save**, and New / PDF / Print / WhatsApp next to it (under ⋯ on a phone, where *Details* and *Preview* switch between the form and the bill).


- **Billing**: GST-inclusive prices, several items per bill, IMEI/serial per item, per-item discount, 0/3/5/12/18/28 % GST
- **CGST + SGST or IGST**: choose "Other state" for inter-state sales; customer GSTIN for B2B bills
- **Payments**: cash / UPI / card / bank / credit. Part payments, balance due, and "Receive payment" later
- **Finance (EMI) sales**: under Payment → *Finance / EMI*, pick the finance company (DMI Finance, Chola, Bajaj Finance, Axio — change the list in Settings → Finance companies). Enter the customer's **down payment**; the rest is the **finance amount**, paid by the finance company and counted as received, so the bill isn't shown as due. Pick the **EMI date** (e.g. 3rd of every month). The bill shows "Down payment" and "Finance (DMI Finance)" under the total, bills get a finance badge, the bill list has a *Financed (EMI)* filter, and Reports show totals per finance company. Update every phone and computer to 2.2.0 before using it: older versions don't know about finance and drop the finance details if they edit a financed bill
- **Narration**: a multi-line box on every bill for EMI details and anything else (printed in a box on the bill, the PDF and the WhatsApp message). Choosing a finance company fills it from that company's template, e.g. *"Please keep the EMI amount in your bank account before the 3rd of every month."* with blanks (`______`) for the loan number and EMI amount. Edit the templates in Settings → Finance companies; they can use `{finance}` `{emiDay}` `{downPayment}` `{financeAmount}` `{total}` `{customer}`
- **App updates**: the Android app checks GitHub for a new version each time it opens, shows *"A new version of the app is ready"*, then downloads it and opens Android's installer (see [Releasing an update](#releasing-an-update))
- **Automatic invoice numbers** per financial year (e.g. `MMM-26-27/00001`). Never duplicated, even when two devices save at the same moment
- **PDF, print and WhatsApp**: A4 tax-invoice PDF, print view, and a WhatsApp message with the bill summary
- **Second shop without GST** (e.g. MAX MOBILES): switch it on in Settings → Second shop. Switch shops by tapping the shop name at the top left. Each shop has its own bills, customers, products, reports and invoice numbers (e.g. `MAX-26-27/00001`). Second-shop bills have no GSTIN, HSN or GST. Second-shop products have a **dealer price code** (A, B, ABC…), a short code for the dealer price. It shows in the product list, billing suggestions and labels, and never on bills.
- **Item numbers and barcodes**: every product gets an item number, which is also its barcode (Code 128). Numbers are automatic (main shop 100001…, second shop 200001…), or type or scan the barcode already on the box. **Print barcode labels** makes a PDF for A4 sticker sheets with 24 labels (3 × 8, 63.5 × 33.9 mm), with copies, one-per-stock-item, and a start position for part-used sheets. Scanning an item number into a bill's item box fills in the product; in product search, it opens the product Both shops sync together. Update the app on every device before using it: older versions don't know about the second shop
- **Signature**: upload your signature in Settings (a transparent PNG, or a photo on white paper). It's printed above "Authorised Signatory" on bills and PDFs, and syncs to every signed-in device
- **Bills**: search by number, customer, phone, item or IMEI; filter by date and paid/due/cancelled; edit, copy, cancel or restore a bill
- **Customers**: built automatically from bills, with total spent and pending dues
- **Products**: price, HSN, GST rate and optional stock. Bills fill these in as you type, and stock goes down on each sale
- **Dashboard and reports**: today's and this month's sales, GST, dues, GST by rate, HSN summary, payment modes, and CSV export for your accountant (GSTR-1)
- **Backup and restore** to a JSON file
- **Google sign-in and sync** for up to 3 devices, with staff accounts and offline support (details below)

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000. Without sign-in, bills are saved in the `data/` folder next to `server.js`. This is the same folder earlier versions used, so your existing bills carry over.

## Turn on Google sign-in and sync (one-time, about 10 minutes)

Sync uses Google Firebase. The free "Spark" plan is plenty for a shop.

1. Go to https://console.firebase.google.com, click **Add project**, and give it a name such as `mm-gst`.
2. **Authentication** → **Get started** → **Sign-in method** → enable **Google**.
3. **Firestore Database** → **Create database** → choose a location near you (e.g. `asia-south1` Mumbai) → **production mode**.
4. **Project settings** (gear icon) → **Your apps** → **Web** (`</>`) → register the app → copy the `firebaseConfig` values into `public/firebase-config.js`:
   ```js
   window.MM_FIREBASE_CONFIG = { apiKey: '...', authDomain: '...', projectId: '...', storageBucket: '...', messagingSenderId: '...', appId: '...' };
   ```
5. Install the security rules. They make sure only your shop's accounts can read your bills, and they enforce the 3-device limit:
   ```bash
   npm install -g firebase-tools
   ```
   ```bash
   firebase login
   ```
   ```bash
   firebase use --add
   ```
   ```bash
   firebase deploy --only firestore:rules
   ```
   (You can also paste the contents of `firestore.rules` into Firestore → Rules → Publish.)
6. **Recommended: put the app online** so every device just opens a web address:
   ```bash
   firebase deploy --only hosting
   ```
   The app is then at `https://<your-project>.web.app`. Open it on each phone or computer and use "Add to home screen".
   If you open the app from any other address, add that address under Authentication → Settings → **Authorized domains**.

### How sync works

- Sign in with the **same Google account** on up to 3 devices. Each device shows a **Synced** badge, and a bill saved on one device appears on the others within a second or two.
- **Staff**: the owner can add staff Gmail addresses (Settings → Sign-in, sync & staff; on a phone: Menu → Sign-in, sync & staff). Staff sign in with their own Google account and work in the owner's shop. They count toward the 3-device limit.
- **Device limit**: a 4th device is asked to remove one of the others first. You can see and remove devices from Settings. A removed device is signed out right away. Signing out frees that device's slot.
- **Offline**: synced bills stay available offline, and edits and payments made offline sync when the internet is back. Creating a *new* bill needs a moment of internet, so that two devices can never get the same invoice number.
- **Existing bills**: the first time you sign in on a device that already has bills, the app offers to copy them into the synced shop. Duplicates are skipped.
- While signed out, the app works exactly as before and saves bills only on that device.

## Releasing an update

New versions reach the phones through **GitHub releases**. When a release is published, GitHub Actions builds and signs the APK and attaches it to the release (`.github/workflows/release-apk.yml`). The Android app checks the latest release whenever it opens and offers the update. Android always shows its own "Do you want to update this app?" screen, so someone taps **Update** on each phone.

### One-time setup: give GitHub the signing key

Android only installs an update over the app already on a phone if it is signed with **the same key**. The app on the phones (version 2.1.0) was built on the shop PC and signed with that PC's Android *debug* key (SHA-1 `EE:6A:7E:BB:3F:78:A4:98:03:8E:9F:AB:D9:73:D5:13:80:08:28:24`, the one registered in Firebase for Google sign-in). GitHub needs a copy of that key file:

1. On the shop PC, the key is `C:\Users\onlys\.android\debug.keystore`. Back it up somewhere safe: if it is lost, updates can't install over the app any more.
2. Open **PowerShell** and copy the file as text to the clipboard:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.android\debug.keystore")) | Set-Clipboard
   ```
3. On GitHub, open this repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, and add these four (the debug key always uses these passwords):

   | Name | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | paste from the clipboard |
   | `ANDROID_KEYSTORE_PASSWORD` | `android` |
   | `ANDROID_KEY_ALIAS` | `androiddebugkey` |
   | `ANDROID_KEY_PASSWORD` | `android` |

Secrets are never shown again or printed in the build logs. Never commit the keystore file itself (`.gitignore` blocks `*.keystore` and `*.jks`).

### Each release

1. Merge the changes into `main`.
2. GitHub → **Releases** → **Draft a new release** → **Choose a tag** → type the new version, e.g. `v2.2.0` → *Create new tag on publish* (target `main`).
3. Write what's new in the description (the app shows it in the update screen), then **Publish release**.
4. In about 5–10 minutes the **Release APK** job (Actions tab) attaches `MM-GST-Billing-v2.2.0.apk` to the release. The job's summary shows the APK's signing key: its SHA-1 must be `ee6a7ebb3f78a498038e9fabd973d51380082824`.
5. Phones see the update the next time the app is opened (or Settings → App version → *Check for updates*).

**Or let the workflow make the release:** Actions → **Release APK** → **Run workflow** (branch `main`), enter the tag (e.g. `v2.2.0`) and what's new. It builds the APK first, then creates the release with the APK already attached.

The version comes from the tag: `v2.3.1` becomes version 2.3.1 (Android version code 20301). Each release needs a higher number than the last. The app only offers a release once its APK is attached, so publishing before the build finishes is fine. To rebuild the APK of an existing release, run the **Release APK** workflow with that release's tag.

**Version 2.1.0 → 2.2.0 is a manual update**, because 2.1.0 doesn't have the update check yet: on each phone, open the release page in the browser, download `MM-GST-Billing-v2.2.0.apk`, open it and tap **Update**. From 2.2.0 on, the app offers updates itself. The first time, Android may ask to allow *MM GST Invoice* to install apps: allow it, go back, and tap Update.

## Android app

The Android project (`android/`) is generated by Capacitor (app ID `com.mmmobiles.gst`, the same as earlier versions, so the new app installs over the old one and keeps its bills).

Build it (run from Command Prompt, since the script uses `set`):

1. `npm install`
2. `npm run android:sync` (copies `public/` into the app; run it after every change to the web files)
3. `npm run android:build`. The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`.

Google sign-in is set up. It uses the Firebase project `mm-gst-billing-4821`, with the Android app registered for this PC's debug signing key (SHA-1 `EE:6A:7E:BB:3F:78:A4:98:03:8E:9F:AB:D9:73:D5:13:80:08:28:24`). The pieces are:

- `public/firebase-config.js`: the web config
- `android/app/google-services.json`: the Android config
- `"@capacitor-firebase/authentication"` in `android.includePlugins` in `capacitor.config.json`
- `rgcfaIncludeGoogle = true` in `android/variables.gradle`

The app crashes at launch if the sign-in plugin is included without `google-services.json`, so keep the two together. If you build on another PC or with a release key, add that key's SHA-1 to the Android app in the Firebase console (`cd android && gradlew signingReport` shows it). Then download `google-services.json` again, or Google sign-in will fail on the phone.

The app uses the native Google account picker, then signs in to the same Firebase project. Bills sync between the Android app and the web app.

## Development: Firebase emulators

```bash
firebase emulators:start --only auth,firestore --project demo-mmgst
```

Then add `emulators: { host: '127.0.0.1' }` to the config object in `public/firebase-config.js`.

## Files

| File | What it does |
| --- | --- |
| `public/index.html`, `public/styles.css` | Screens and styles |
| `public/js/app.js` | Screens, billing form, reports, sign-in flow |
| `public/js/util.js` | GST maths, invoice numbering, data clean-up and migration |
| `public/js/icons.js` | Line icons used by the screens |
| `public/js/pdf.js` | Invoice PDF (no library, works offline) |
| `public/js/store-local.js` | Saving on this device (server `data/`, Android storage, or browser storage) |
| `public/js/cloud.js` | Google sign-in, Firestore sync, device slots, staff |
| `public/js/update.js`, `public/js/version.js` | App version, update check against GitHub releases, APK download + install |
| `.github/workflows/release-apk.yml` | Builds, signs and attaches the APK when a release is published |
| `.github/workflows/check.yml` | Runs the tests and builds the Android app on every pull request |
| `test/` | Tests (`npm test`) |
| `firestore.rules` | Cloud security rules (shop access, 3-device limit) |
| `server.js` | Local server for `npm start` |
