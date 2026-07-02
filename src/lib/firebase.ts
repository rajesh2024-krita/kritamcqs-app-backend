import {
  cert,
  getApp,
  getApps,
  initializeApp,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging as getAdminMessaging } from "firebase-admin/messaging";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

type ServiceAccountSource = "base64" | "json" | "individual_env_vars";

function loadBackendEnvironment() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env["DOTENV_CONFIG_PATH"],
    path.resolve(process.cwd(), ".env"),
    path.resolve(moduleDirectory, "..", ".env"),
    path.resolve(moduleDirectory, "..", "..", ".env"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const environmentPath = candidates.find((candidate) => existsSync(candidate));
  if (environmentPath) {
    loadEnv({ path: environmentPath, override: false, quiet: true });
  }
}

loadBackendEnvironment();

function normalizeServiceAccount(value: unknown): ServiceAccount {
  const record = value as Record<string, unknown>;
  const projectId = String(record?.["projectId"] || record?.["project_id"] || "").trim();
  const clientEmail = String(record?.["clientEmail"] || record?.["client_email"] || "").trim();
  const privateKey = String(record?.["privateKey"] || record?.["private_key"] || "")
    .replace(/\\n/g, "\n")
    .trim();
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase service account is missing project_id, client_email, or private_key.");
  }
  return { projectId, clientEmail, privateKey };
}

function parseServiceAccount(): {
  serviceAccount: ServiceAccount | null;
  source: ServiceAccountSource | null;
} {
  const rawJson = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  const rawBase64 = process.env["FIREBASE_SERVICE_ACCOUNT_BASE64"];
  const projectId = process.env["FIREBASE_PROJECT_ID"];
  const clientEmail = process.env["FIREBASE_CLIENT_EMAIL"];
  const privateKey = process.env["FIREBASE_PRIVATE_KEY"]?.replace(/\\n/g, "\n");

  // Base64 is preferred because process managers and shell parsers commonly
  // damage multiline JSON/private-key values.
  if (rawBase64) {
    try {
      return {
        serviceAccount: normalizeServiceAccount(
          JSON.parse(Buffer.from(rawBase64.trim(), "base64").toString("utf8")),
        ),
        source: "base64",
      };
    } catch (error) {
      logger.error(
        { message: error instanceof Error ? error.message : "Unknown Base64 credential error" },
        "FIREBASE_SERVICE_ACCOUNT_BASE64 is invalid; trying another credential source",
      );
    }
  }

  if (rawJson) {
    try {
      return {
        serviceAccount: normalizeServiceAccount(JSON.parse(rawJson)),
        source: "json",
      };
    } catch (error) {
      logger.error(
        { message: error instanceof Error ? error.message : "Unknown JSON credential error" },
        "FIREBASE_SERVICE_ACCOUNT_JSON is invalid; trying individual environment variables",
      );
    }
  }

  if (projectId && clientEmail && privateKey) {
    return {
      serviceAccount: normalizeServiceAccount({ projectId, clientEmail, privateKey }),
      source: "individual_env_vars",
    };
  }

  return { serviceAccount: null, source: null };
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

  const { serviceAccount, source } = parseServiceAccount();
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
      credentialSource: source,
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
