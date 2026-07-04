import { createPrivateKey } from "node:crypto";
import fs from "node:fs/promises";
import {
  AppStoreServerAPIClient,
  AutoRenewStatus,
  Environment,
  SignedDataVerifier,
  Status,
  VerificationStatus,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { logger } from "../lib/logger";
import {
  APPLE_BUNDLE_ID,
  AppleReceiptError,
  type VerifiedAppleReceipt,
} from "./appleReceiptService";

type AppleEnvironmentName = "Production" | "Sandbox";

type VerifiedNotification = {
  notification: ResponseBodyV2DecodedPayload;
  transaction?: JWSTransactionDecodedPayload;
  renewal?: JWSRenewalInfoDecodedPayload;
  environment: AppleEnvironmentName;
};

type VerifierSet = {
  production?: SignedDataVerifier;
  productionUnavailableReason?: string;
  sandbox: SignedDataVerifier;
};

type SignedPayloadDiagnostics = {
  environmentHint?: AppleEnvironmentName;
  bundleId?: string;
  productId?: string;
  transactionId?: string;
  originalTransactionId?: string;
};

type VerificationFailure = {
  environment: AppleEnvironmentName;
  detail: string;
};

class AppleSignedDataVerificationError extends Error {
  constructor(
    message: string,
    readonly failures: VerificationFailure[],
  ) {
    super(message);
    this.name = "AppleSignedDataVerificationError";
  }
}

let verifierPromise: Promise<VerifierSet> | undefined;
const apiClients = new Map<AppleEnvironmentName, AppStoreServerAPIClient>();

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeEnvironment(value: unknown): AppleEnvironmentName | undefined {
  const normalized = stringValue(value)?.toLowerCase();
  if (normalized === "production") return "Production";
  if (normalized === "sandbox") return "Sandbox";
  return undefined;
}

/**
 * This decode is used only to choose which verifier to try first and to improve
 * diagnostics. No value from it is trusted until SignedDataVerifier succeeds.
 */
function inspectSignedPayload(signedPayload: string): SignedPayloadDiagnostics {
  try {
    const encodedPayload = signedPayload.split(".")[1];
    if (!encodedPayload) return {};
    const payload = objectValue(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
    const data = objectValue(payload?.["data"]);
    return {
      environmentHint: normalizeEnvironment(payload?.["environment"] ?? data?.["environment"]),
      bundleId: stringValue(payload?.["bundleId"] ?? data?.["bundleId"]),
      productId: stringValue(payload?.["productId"]),
      transactionId: stringValue(payload?.["transactionId"]),
      originalTransactionId: stringValue(payload?.["originalTransactionId"]),
    };
  } catch {
    return {};
  }
}

function serializeAppleException(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const appleError = error as Error & {
    status?: number;
    code?: string | number;
    cause?: unknown;
  };
  return {
    name: appleError.name,
    message: appleError.message,
    stack: appleError.stack,
    code: appleError.code,
    verificationStatus:
      typeof appleError.status === "number"
        ? VerificationStatus[appleError.status] ?? appleError.status
        : undefined,
    cause:
      appleError.cause && depth < 2
        ? serializeAppleException(appleError.cause, depth + 1)
        : undefined,
  };
}

function exceptionDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const appleError = error as Error & { status?: number; cause?: unknown };
  const status =
    typeof appleError.status === "number"
      ? VerificationStatus[appleError.status] ?? String(appleError.status)
      : undefined;
  const cause =
    appleError.cause instanceof Error && appleError.cause.message !== appleError.message
      ? `; cause: ${appleError.cause.message}`
      : "";
  return `${status ? `${status}: ` : ""}${appleError.message}${cause}`;
}

async function auditAppStoreServerApiCredentials(): Promise<void> {
  const keyId = stringValue(process.env["APPLE_KEY_ID"]);
  const issuerId = stringValue(process.env["APPLE_ISSUER_ID"]);
  const privateKeyPath = stringValue(process.env["APPLE_PRIVATE_KEY_PATH"]);
  const inlinePrivateKey = stringValue(process.env["APPLE_PRIVATE_KEY"]);
  const hasAnyCredentials = Boolean(keyId || issuerId || privateKeyPath || inlinePrivateKey);

  if (!hasAnyCredentials) {
    logger.warn(
      {
        bundleId: APPLE_BUNDLE_ID,
        keyIdConfigured: false,
        issuerIdConfigured: false,
        privateKeyConfigured: false,
      },
      "App Store Server API credentials are not configured; signed JWS verification remains available",
    );
    return;
  }

  try {
    if (!keyId || !issuerId || (!privateKeyPath && !inlinePrivateKey)) {
      throw new Error(
        "APPLE_KEY_ID, APPLE_ISSUER_ID, and either APPLE_PRIVATE_KEY_PATH or APPLE_PRIVATE_KEY must be configured together.",
      );
    }
    const privateKey = privateKeyPath
      ? await fs.readFile(privateKeyPath, "utf8")
      : inlinePrivateKey!.replace(/\\n/g, "\n");
    createPrivateKey(privateKey);
    logger.info(
      {
        bundleId: APPLE_BUNDLE_ID,
        keyId,
        issuerId,
        privateKeySource: privateKeyPath ? "file" : "environment",
      },
      "App Store Server API credentials passed local validation",
    );
  } catch (error) {
    logger.error(
      {
        bundleId: APPLE_BUNDLE_ID,
        keyId,
        issuerId,
        privateKeyPath,
        appleException: serializeAppleException(error),
      },
      "App Store Server API credentials failed local validation",
    );
  }
}

async function readServerApiCredentials() {
  const keyId = stringValue(process.env["APPLE_KEY_ID"]);
  const issuerId = stringValue(process.env["APPLE_ISSUER_ID"]);
  const privateKeyPath = stringValue(process.env["APPLE_PRIVATE_KEY_PATH"]);
  const inlinePrivateKey = stringValue(process.env["APPLE_PRIVATE_KEY"]);
  if (!keyId || !issuerId || (!privateKeyPath && !inlinePrivateKey)) {
    throw new AppleReceiptError(
      "App Store Server API credentials are not configured.",
      "apple_configuration_error",
      503,
    );
  }
  const privateKey = privateKeyPath
    ? await fs.readFile(privateKeyPath, "utf8")
    : inlinePrivateKey!.replace(/\\n/g, "\n");
  return { keyId, issuerId, privateKey };
}

async function getServerApiClient(environment: AppleEnvironmentName) {
  const existing = apiClients.get(environment);
  if (existing) return existing;
  const credentials = await readServerApiCredentials();
  const client = new AppStoreServerAPIClient(
    credentials.privateKey,
    credentials.keyId,
    credentials.issuerId,
    APPLE_BUNDLE_ID,
    environment === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION,
  );
  apiClients.set(environment, client);
  return client;
}

async function createVerifiers(): Promise<VerifierSet> {
  if (!APPLE_BUNDLE_ID.trim()) {
    throw new Error("APPLE_BUNDLE_ID is required for Apple signed-data verification.");
  }

  const certificatePaths = String(process.env["APPLE_ROOT_CA_PATHS"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!certificatePaths.length) {
    throw new Error("APPLE_ROOT_CA_PATHS is required for Apple signed-data verification.");
  }

  const roots = await Promise.all(certificatePaths.map((certificatePath) => fs.readFile(certificatePath)));
  const enableOnlineChecks = process.env["APPLE_ENABLE_ONLINE_CHECKS"] !== "false";
  const rawAppId = stringValue(process.env["APPLE_APP_ID"]);
  const appAppleId = rawAppId ? Number(rawAppId) : undefined;
  const validAppAppleId =
    appAppleId !== undefined && Number.isSafeInteger(appAppleId) && appAppleId > 0
      ? appAppleId
      : undefined;
  const productionUnavailableReason = validAppAppleId
    ? undefined
    : "APPLE_APP_ID must be the positive numeric Apple App ID for Production verification.";

  const verifiers: VerifierSet = {
    production: validAppAppleId
      ? new SignedDataVerifier(
          roots,
          enableOnlineChecks,
          Environment.PRODUCTION,
          APPLE_BUNDLE_ID,
          validAppAppleId,
        )
      : undefined,
    productionUnavailableReason,
    sandbox: new SignedDataVerifier(
      roots,
      enableOnlineChecks,
      Environment.SANDBOX,
      APPLE_BUNDLE_ID,
    ),
  };

  logger.info(
    {
      bundleId: APPLE_BUNDLE_ID,
      appAppleId: validAppAppleId,
      rootCertificatePaths: certificatePaths,
      rootCertificateCount: roots.length,
      enableOnlineChecks,
      productionVerifierConfigured: Boolean(verifiers.production),
      sandboxVerifierConfigured: true,
      productionUnavailableReason,
    },
    "Apple signed-data verifiers configured",
  );
  await auditAppStoreServerApiCredentials();
  return verifiers;
}

async function getVerifiers(): Promise<VerifierSet> {
  verifierPromise ||= createVerifiers();
  return verifierPromise;
}

function verificationOrder(
  environmentHint?: AppleEnvironmentName,
): AppleEnvironmentName[] {
  if (environmentHint === "Sandbox") return ["Sandbox", "Production"];
  return ["Production", "Sandbox"];
}

async function verifyInCorrectEnvironment<T>(
  operation: "notification" | "transaction" | "renewal",
  signedPayload: string,
  verify: (verifier: SignedDataVerifier) => Promise<T>,
): Promise<{ decoded: T; environment: AppleEnvironmentName }> {
  const verifiers = await getVerifiers();
  const diagnostics = inspectSignedPayload(signedPayload);
  const failures: VerificationFailure[] = [];

  for (const environment of verificationOrder(diagnostics.environmentHint)) {
    const verifier = environment === "Production" ? verifiers.production : verifiers.sandbox;
    if (!verifier) {
      const detail =
        verifiers.productionUnavailableReason ?? `${environment} verifier is not configured.`;
      failures.push({ environment, detail });
      logger.warn(
        {
          operation,
          verificationEnvironment: environment,
          configuredBundleId: APPLE_BUNDLE_ID,
          ...diagnostics,
          detail,
        },
        "Apple signed-data verification environment is unavailable",
      );
      continue;
    }

    logger.info(
      {
        operation,
        verificationEnvironment: environment,
        configuredBundleId: APPLE_BUNDLE_ID,
        ...diagnostics,
      },
      "Attempting Apple signed-data verification",
    );
    try {
      const decoded = await verify(verifier);
      logger.info(
        {
          operation,
          verificationEnvironment: environment,
          configuredBundleId: APPLE_BUNDLE_ID,
          ...diagnostics,
        },
        "Apple signed-data verification succeeded",
      );
      return { decoded, environment };
    } catch (error) {
      const detail = exceptionDetail(error);
      failures.push({ environment, detail });
      logger.warn(
        {
          operation,
          verificationEnvironment: environment,
          configuredBundleId: APPLE_BUNDLE_ID,
          ...diagnostics,
          appleException: serializeAppleException(error),
        },
        "Apple signed-data verification attempt failed",
      );
    }
  }

  const details = failures
    .map((failure) => `${failure.environment}: ${failure.detail}`)
    .join(" | ");
  throw new AppleSignedDataVerificationError(
    `Apple signed ${operation} validation failed. ${details || "No verifier was available."}`,
    failures,
  );
}

export async function getLatestAppleSubscriptionStatus(
  originalTransactionId: string,
  expectedProductId: string,
  environment: AppleEnvironmentName = "Production",
): Promise<VerifiedAppleReceipt> {
  try {
    const client = await getServerApiClient(environment);
    const response = await client.getAllSubscriptionStatuses(originalTransactionId);
    const candidates = (response.data || [])
      .flatMap((group) => group.lastTransactions || [])
      .filter(
        (item) =>
          item.originalTransactionId === originalTransactionId &&
          Boolean(item.signedTransactionInfo),
      );

    const decoded = await Promise.all(
      candidates.map(async (item) => {
        const transactionResult = await verifyInCorrectEnvironment(
          "transaction",
          item.signedTransactionInfo!,
          (verifier) => verifier.verifyAndDecodeTransaction(item.signedTransactionInfo!),
        );
        const renewalResult = item.signedRenewalInfo
          ? await verifyInCorrectEnvironment(
              "renewal",
              item.signedRenewalInfo,
              (verifier) => verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo!),
            )
          : undefined;
        return {
          item,
          transaction: transactionResult.decoded,
          renewal: renewalResult?.decoded,
          environment: transactionResult.environment,
        };
      }),
    );
    const latest = decoded
      .filter(
        ({ transaction }) =>
          transaction.originalTransactionId === originalTransactionId &&
          transaction.productId === expectedProductId,
      )
      .sort(
        (left, right) =>
          Number(right.transaction.expiresDate || 0) -
          Number(left.transaction.expiresDate || 0),
      )[0];

    if (
      !latest?.transaction.transactionId ||
      !latest.transaction.productId ||
      !latest.transaction.purchaseDate ||
      !latest.transaction.expiresDate
    ) {
      throw new AppleReceiptError(
        "Apple did not return a valid status for this subscription.",
        "apple_subscription_not_found",
        404,
      );
    }

    const transactionExpiry = new Date(latest.transaction.expiresDate);
    const graceExpiry = Number(latest.renewal?.gracePeriodExpiresDate || 0);
    const expiryDate =
      graceExpiry > transactionExpiry.getTime() ? new Date(graceExpiry) : transactionExpiry;
    const status = latest.item.status;
    const refunded = status === Status.REVOKED || Boolean(latest.transaction.revocationDate);
    const activeStatus =
      status === Status.ACTIVE || status === Status.BILLING_GRACE_PERIOD;

    return {
      productId: latest.transaction.productId,
      transactionId: latest.transaction.transactionId,
      originalTransactionId,
      purchaseDate: new Date(latest.transaction.purchaseDate),
      expiryDate,
      active: !refunded && activeStatus && expiryDate.getTime() > Date.now(),
      refunded,
      autoRenewStatus: latest.renewal?.autoRenewStatus !== AutoRenewStatus.OFF,
      billingRetry:
        status === Status.BILLING_RETRY ||
        Boolean(latest.renewal?.isInBillingRetryPeriod),
      environment: latest.environment,
      amount:
        typeof latest.transaction.price === "number"
          ? latest.transaction.price / 1000
          : undefined,
      currency: stringValue(latest.transaction.currency),
    };
  } catch (error) {
    if (error instanceof AppleReceiptError) throw error;
    logger.warn(
      {
        err: error,
        originalTransactionId,
        environment,
      },
      "App Store Server API subscription status request failed",
    );
    throw new AppleReceiptError(
      "Apple subscription status is temporarily unavailable.",
      "apple_subscription_status_unavailable",
      502,
    );
  }
}

export async function verifyAppleNotification(signedPayload: string): Promise<VerifiedNotification> {
  const verified = await verifyInCorrectEnvironment(
    "notification",
    signedPayload,
    async (verifier) => {
      const notification = await verifier.verifyAndDecodeNotification(signedPayload);
      const transaction = notification.data?.signedTransactionInfo
        ? await verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo)
        : undefined;
      const renewal = notification.data?.signedRenewalInfo
        ? await verifier.verifyAndDecodeRenewalInfo(notification.data.signedRenewalInfo)
        : undefined;
      return { notification, transaction, renewal };
    },
  );

  return { ...verified.decoded, environment: verified.environment };
}

export async function verifyAppleTransaction(
  signedTransactionInfo: string,
  expectedProductIds: string | string[],
): Promise<VerifiedAppleReceipt> {
  const supportedProductIds = new Set(
    (Array.isArray(expectedProductIds) ? expectedProductIds : [expectedProductIds])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (!supportedProductIds.size) {
    throw new AppleReceiptError(
      "No iOS subscription products are configured.",
      "apple_configuration_error",
      503,
    );
  }

  let verified: {
    decoded: JWSTransactionDecodedPayload;
    environment: AppleEnvironmentName;
  };
  try {
    verified = await verifyInCorrectEnvironment(
      "transaction",
      signedTransactionInfo,
      (verifier) => verifier.verifyAndDecodeTransaction(signedTransactionInfo),
    );
  } catch (error) {
    const isConfigurationError =
      error instanceof Error &&
      (error.message.includes("APPLE_") || error.message.includes("root CA"));
    throw new AppleReceiptError(
      error instanceof Error
        ? error.message
        : "Apple signed transaction validation failed with an unknown verification exception.",
      isConfigurationError ? "apple_configuration_error" : "apple_jws_verification_failed",
      isConfigurationError ? 503 : 400,
    );
  }

  const transaction = verified.decoded;
  logger.info(
    {
      verificationEnvironment: verified.environment,
      bundleId: transaction.bundleId,
      productId: transaction.productId,
      transactionId: transaction.transactionId,
      originalTransactionId: transaction.originalTransactionId,
    },
    "Validated Apple transaction details",
  );

  if (!transaction.productId || !supportedProductIds.has(transaction.productId)) {
    throw new AppleReceiptError(
      "The signed transaction does not contain the selected subscription product.",
      "apple_product_mismatch",
    );
  }
  if (!transaction.transactionId || !transaction.originalTransactionId) {
    throw new AppleReceiptError(
      "The signed transaction is missing transaction identifiers.",
      "invalid_apple_transaction",
    );
  }
  if (!transaction.purchaseDate || !transaction.expiresDate) {
    throw new AppleReceiptError(
      "The signed transaction is missing subscription dates.",
      "invalid_apple_transaction",
    );
  }

  const purchaseDate = new Date(transaction.purchaseDate);
  const expiryDate = new Date(transaction.expiresDate);
  const refunded = Boolean(transaction.revocationDate);
  return {
    productId: transaction.productId,
    transactionId: transaction.transactionId,
    originalTransactionId: transaction.originalTransactionId,
    purchaseDate,
    expiryDate,
    active: !refunded && !transaction.isUpgraded && expiryDate.getTime() > Date.now(),
    refunded,
    autoRenewStatus: true,
    billingRetry: false,
    environment: verified.environment,
    amount: typeof transaction.price === "number" ? transaction.price / 1000 : undefined,
    currency: stringValue(transaction.currency),
  };
}
