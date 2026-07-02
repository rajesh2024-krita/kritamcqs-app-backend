import {
  cert,
  getApp,
  getApps,
  initializeApp,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging as getAdminMessaging } from "firebase-admin/messaging";
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

function getServiceAccountProjectId(serviceAccount: ServiceAccount | null) {
  if (!serviceAccount) return "";
  const account = serviceAccount as ServiceAccount & { project_id?: string };
  return String(account.projectId || account.project_id || "").trim();
}

export function getFirebaseAdminApp() {
  if (getApps().length) {
    return getApp();
  }

  const serviceAccount = parseServiceAccount();
  const environmentProjectId = String(process.env["FIREBASE_PROJECT_ID"] || "").trim();
  const serviceAccountProjectId = getServiceAccountProjectId(serviceAccount);
  const projectId = serviceAccountProjectId || environmentProjectId;
  if (
    serviceAccountProjectId &&
    environmentProjectId &&
    serviceAccountProjectId !== environmentProjectId
  ) {
    throw new Error(
      `Firebase project mismatch: service account uses "${serviceAccountProjectId}" but FIREBASE_PROJECT_ID is "${environmentProjectId}".`,
    );
  }

  if (!serviceAccount) {
    logger.warn(
      { projectId: projectId || null },
      "Firebase Admin credentials are not configured; application default credentials will be used.",
    );
    return initializeApp(projectId ? { projectId } : undefined);
  }

  logger.info(
    {
      projectId,
      credentialSource: process.env["FIREBASE_SERVICE_ACCOUNT_JSON"]
        ? "json"
        : process.env["FIREBASE_SERVICE_ACCOUNT_BASE64"]
          ? "base64"
          : "individual_env_vars",
    },
    "Initializing Firebase Admin",
  );
  return initializeApp({
    credential: cert(serviceAccount),
    projectId,
  });
}

export function getMessaging() {
  return getAdminMessaging(getFirebaseAdminApp());
}

export function getFirebaseAuth() {
  return getAuth(getFirebaseAdminApp());
}
