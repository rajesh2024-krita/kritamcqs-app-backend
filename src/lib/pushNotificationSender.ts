import jwt from "jsonwebtoken";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

type ServiceAccount = {
  projectId?: string;
  clientEmail?: string;
  privateKeyId?: string;
  privateKey?: string;
};

type PushPayload = {
  title?: string;
  body?: string;
  message?: string;
  image?: string;
  imageUrl?: string;
  deepLink?: string;
  linkUrl?: string;
  category?: string;
  sound?: string;
  priority?: "high" | "low" | string;
  data?: Record<string, unknown>;
};

let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt = 0;

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

function parseJsonCredential(value: string, label: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function getServiceAccount(): ServiceAccount {
  const rawBase64 = process.env["FIREBASE_SERVICE_ACCOUNT_BASE64"];
  const rawJson = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];

  if (rawBase64) {
    const decoded = Buffer.from(rawBase64.trim(), "base64").toString("utf8");
    const parsed = parseJsonCredential(decoded, "FIREBASE_SERVICE_ACCOUNT_BASE64");
    return {
      projectId: parsed.project_id || parsed.projectId || process.env["FIREBASE_PROJECT_ID"],
      clientEmail: parsed.client_email || parsed.clientEmail,
      privateKeyId: parsed.private_key_id || parsed.privateKeyId || process.env["FIREBASE_PRIVATE_KEY_ID"],
      privateKey: parsed.private_key || parsed.privateKey,
    };
  }

  if (rawJson) {
    const parsed = parseJsonCredential(rawJson, "FIREBASE_SERVICE_ACCOUNT_JSON");
    return {
      projectId: parsed.project_id || parsed.projectId || process.env["FIREBASE_PROJECT_ID"],
      clientEmail: parsed.client_email || parsed.clientEmail,
      privateKeyId: parsed.private_key_id || parsed.privateKeyId || process.env["FIREBASE_PRIVATE_KEY_ID"],
      privateKey: parsed.private_key || parsed.privateKey,
    };
  }

  return {
    projectId: process.env["FIREBASE_PROJECT_ID"],
    clientEmail: process.env["FIREBASE_CLIENT_EMAIL"],
    privateKeyId: process.env["FIREBASE_PRIVATE_KEY_ID"],
    privateKey: process.env["FIREBASE_PRIVATE_KEY"],
  };
}

function normalizePrivateKey(value = "") {
  return String(value || "").replace(/\\n/g, "\n");
}

function assertFirebaseConfig() {
  const account = getServiceAccount();
  if (!account.projectId || !account.clientEmail || !account.privateKey) {
    throw new Error("Firebase service account is not configured");
  }
  return { ...account, privateKey: normalizePrivateKey(account.privateKey) };
}

export function isPushConfigured() {
  try {
    assertFirebaseConfig();
    return true;
  } catch {
    return false;
  }
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const account = assertFirebaseConfig();
  const issuedAt = Math.floor(now / 1000);
  const assertion = jwt.sign(
    {
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    },
    account.privateKey,
    { algorithm: "RS256", ...(account.privateKeyId ? { keyid: account.privateKeyId } : {}) },
  );

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to get Firebase access token");
  }

  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = now + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

function isInvalidTokenError(status: number, body: unknown) {
  const text = JSON.stringify(body || {}).toLowerCase();
  return status === 404 || text.includes("registration-token-not-registered") || text.includes("invalidargument");
}

function normalizeData(data: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value ?? "")]));
}

function normalizeImageUrl(value = "") {
  const image = String(value || "").trim();
  if (!image) return "";
  if (/^https?:\/\//i.test(image)) return image;
  const baseUrl = String(process.env["APP_ASSET_BASE_URL"] || process.env["PUBLIC_API_BASE_URL"] || "").replace(/\/+$/, "");
  return baseUrl && image.startsWith("/") ? `${baseUrl}${image}` : image;
}

export async function sendPushToTokens(tokens: string[] = [], payload: PushPayload = {}) {
  const uniqueTokens = [...new Set(tokens.map((token) => String(token || "").trim()).filter(Boolean))];
  const result = { attempted: uniqueTokens.length, successCount: 0, failedCount: 0, invalidTokens: [] as string[], errors: [] as string[] };
  if (!uniqueTokens.length) return result;

  const account = assertFirebaseConfig();
  const accessToken = await getAccessToken();
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`;

  for (const token of uniqueTokens) {
    const image = normalizeImageUrl(payload.image || payload.imageUrl);
    const message = {
      token,
      notification: {
        title: String(payload.title || ""),
        body: String(payload.body || payload.message || ""),
        ...(image ? { image } : {}),
      },
      data: normalizeData({
        deepLink: payload.deepLink || payload.linkUrl || "/notifications",
        linkUrl: payload.deepLink || payload.linkUrl || "/notifications",
        category: payload.category || "custom",
        sound: payload.sound || "default",
        priority: payload.priority || "high",
        ...payload.data,
      }),
      android: {
        priority: payload.priority === "low" ? "NORMAL" : "HIGH",
        notification: {
          sound: payload.sound === "silent" ? undefined : payload.sound || "default",
          channel_id: "default",
        },
      },
      apns: {
        payload: {
          aps: {
            sound: payload.sound === "silent" ? undefined : payload.sound || "default",
          },
        },
      },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    const body = await response.json().catch(() => ({}));

    if (response.ok) {
      result.successCount += 1;
      logger.info({
        projectId: account.projectId,
        tokenSuffix: token.slice(-8),
        title: String(payload.title || ""),
      }, "[FCM HTTP V1 SENT SUCCESS]");
      continue;
    }

    result.failedCount += 1;
    if (isInvalidTokenError(response.status, body)) {
      result.invalidTokens.push(token);
    }
    const errorMessage = (body as any).error?.message || (body as any).error || `FCM failed with ${response.status}`;
    logger.error({
      projectId: account.projectId,
      tokenSuffix: token.slice(-8),
      status: response.status,
      body,
      error: errorMessage,
    }, "[FCM HTTP V1 SENT FAILED]");
    result.errors.push(errorMessage);
  }

  return { ...result, errors: [...new Set(result.errors)] };
}
