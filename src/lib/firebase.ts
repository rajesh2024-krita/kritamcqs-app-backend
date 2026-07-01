import admin, { type ServiceAccount } from "firebase-admin";
import { logger } from "./logger";

function parseServiceAccount(): ServiceAccount | null {
  const rawJson = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  const rawBase64 = process.env["FIREBASE_SERVICE_ACCOUNT_BASE64"];
  const projectId = process.env["FIREBASE_PROJECT_ID"];
  const clientEmail = process.env["FIREBASE_CLIENT_EMAIL"];
  const privateKey = process.env["FIREBASE_PRIVATE_KEY"]?.replace(/\\n/g, "\n");

  if (rawJson) {
    return JSON.parse(rawJson) as ServiceAccount;
  }

  if (rawBase64) {
    return JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8")) as ServiceAccount;
  }

  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }

  return null;
}

export function getFirebaseAdminApp() {
  if (admin.apps.length) {
    return admin.app();
  }

  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    logger.warn("Firebase Admin credentials are not configured; FCM sends will fail until env vars are set.");
    return admin.initializeApp();
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export function getMessaging() {
  return getFirebaseAdminApp().messaging();
}

export function getFirebaseAuth() {
  return getFirebaseAdminApp().auth();
}
