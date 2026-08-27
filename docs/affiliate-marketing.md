# Affiliate marketing deployment

The affiliate module is additive: it stores attribution and reporting records beside the existing users and subscriptions. Existing entitlement and payment calculations remain unchanged. Razorpay conversions are recorded only after signature, order, amount, ownership, and capture checks pass. Apple conversions are recorded only after the receipt/JWS flow activates the subscription. `transactionId` has a unique database index, providing callback idempotency.

## Services

- App API: public click tracking and authenticated application-user attribution at trusted registration/payment boundaries.
- Affiliate API (`kritamcqs-affiliate-backend`): isolated affiliate authentication and self-service APIs using the shared MongoDB database.
- Admin API and panel: affiliate creation, status control, reporting, settings and audit records.
- `kritamcqs-affiliate-frontend`: independent affiliate UI. It must point only at the dedicated Affiliate API with `VITE_API_BASE_URL`.

Local startup:

```bash
cd kritamcqs-affiliate-backend
npm install
npm run dev

cd ../kritamcqs-affiliate-frontend
npm install
npm run dev -- --port 5176
```

Set a separate, random `AFFILIATE_JWT_SECRET` in the dedicated affiliate backend. Configure its `CLIENT_ORIGIN` for the affiliate panel. The affiliate frontend must use the dedicated API URL, such as `VITE_API_BASE_URL=https://affiliateapi.kritamcqs.com/api`.

For local development the affiliate backend loads `MONGODB_URI` from `../kritamcqs-admin-backend/.env` when its own environment does not define one. This reuses the same database without copying credentials. Affiliate writes are restricted by explicit model mappings to `affiliates`, `affiliatereferrals`, `affiliatepurchases`, and `affiliatenotifications`; the existing `users` collection is queried read-only.

## Attribution behavior

Web referral links use `?ref=CODE`. The app records a click ID locally and attaches it during registration or the next authenticated login. An existing first attribution is retained. Expired clicks are rejected according to `attributionWindowDays`. Android/iOS metadata is accepted through the same tracking endpoint and normalized to `WEB`, `ANDROID`, or `IOS`.

Android deferred attribution uses Google Play Install Referrer as described below. iOS deferred attribution still requires a supported provider capable of carrying signed link data across App Store installation, so the implementation does not claim unverifiable iOS install attribution. Direct app/deep-link launches call `POST /api/affiliate/track`, retain the returned click ID, and call `POST /api/affiliate/attribution` after authentication.

## Android App Link and deferred install attribution

Affiliate links use `https://app.kritamcqs.com/affiliate?ref=CODE`. Android opens this verified App Link directly when Krita MCQs is installed. When it is not installed, the web route records the click and redirects to Google Play with `referral_click_id` and `affiliate_code` in the Play referrer. On first launch, the native `KritaInstallReferrer` Capacitor plugin reads that value once, records `firstAppOpenAt`, and retains it through login/registration and verified payment.

The deployed `https://app.kritamcqs.com/.well-known/assetlinks.json` must contain the SHA-256 fingerprint shown in Google Play Console under **Setup → App integrity → App signing key certificate**. The repository currently contains a replacement marker; App Links will not verify until that value is replaced. After deployment, verify with `adb shell pm verify-app-links --re-verify app.kritamcqs.androidapp` and inspect with `adb shell pm get-app-links app.kritamcqs.androidapp`.

## Rollout checks

Before production rollout, build all four projects, allow Mongoose to create the new unique indexes, test with staging Razorpay/Apple transactions, verify the affiliate-panel CORS origin, and reconcile dashboard totals against `affiliatepurchases`. Do not import historical conversions without a separately reviewed migration.
