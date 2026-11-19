# MM GST Billing

GST billing software for MM Mobiles. It runs in a browser, as a desktop app (`npm start`) and as an Android app (Capacitor).
Sign in with Google to keep bills in sync live on up to **3 devices** (phones and computers) at the same time.

## Features

- **Billing**: GST-inclusive prices, several items per bill, IMEI/serial per item, per-item discount, 0/3/5/12/18/28 % GST
- **CGST + SGST or IGST**: choose "Other state" for inter-state sales; customer GSTIN for B2B bills
- **Payments**: cash / UPI / card / bank / credit. Part payments, balance due, and "Receive payment" later
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
- **Staff**: the owner can add staff Gmail addresses (Settings → Google sign-in & sync → Staff accounts). Staff sign in with their own Google account and work in the owner's shop. They count toward the 3-device limit.
- **Device limit**: a 4th device is asked to remove one of the others first. You can see and remove devices from Settings. A removed device is signed out right away. Signing out frees that device's slot.
- **Offline**: synced bills stay available offline, and edits and payments made offline sync when the internet is back. Creating a *new* bill needs a moment of internet, so that two devices can never get the same invoice number.
- **Existing bills**: the first time you sign in on a device that already has bills, the app offers to copy them into the synced shop. Duplicates are skipped.
- While signed out, the app works exactly as before and saves bills only on that device.

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
| `public/js/pdf.js` | Invoice PDF (no library, works offline) |
| `public/js/store-local.js` | Saving on this device (server `data/`, Android storage, or browser storage) |
| `public/js/cloud.js` | Google sign-in, Firestore sync, device slots, staff |
| `firestore.rules` | Cloud security rules (shop access, 3-device limit) |
| `server.js` | Local server for `npm start` |
