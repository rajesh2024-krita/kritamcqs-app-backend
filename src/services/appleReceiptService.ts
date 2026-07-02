import { logger } from "../lib/logger";

const PRODUCTION_VERIFY_URL = "https://buy.itunes.apple.com/verifyReceipt";
const SANDBOX_VERIFY_URL = "https://sandbox.itunes.apple.com/verifyReceipt";

export const APPLE_BUNDLE_ID = process.env["APPLE_BUNDLE_ID"] || "app.kritamcqs.iosapp";
export const APPLE_PRODUCT_ID =
  process.env["APPLE_PREMIUM_PRODUCT_ID"] || "app.kritamcqs.iosapp.premium.6months";

type AppleReceiptTransaction = {
  product_id?: string;
  transaction_id?: string;
  original_transaction_id?: string;
  purchase_date_ms?: string;
  expires_date_ms?: string;
  cancellation_date_ms?: string;
};

type PendingRenewalInfo = {
  product_id?: string;
  auto_renew_product_id?: string;
  original_transaction_id?: string;
  auto_renew_status?: string;
  expiration_intent?: string;
  is_in_billing_retry_period?: string;
  grace_period_expires_date_ms?: string;
};

type VerifyReceiptResponse = {
  status?: number;
  environment?: string;
  receipt?: {
    bundle_id?: string;
    in_app?: AppleReceiptTransaction[];
  };
  latest_receipt_info?: AppleReceiptTransaction[];
  pending_renewal_info?: PendingRenewalInfo[];
};

export class AppleReceiptError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus = 400,
    public readonly appleStatus?: number,
  ) {
    super(message);
  }
}

export type VerifiedAppleReceipt = {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  purchaseDate: Date;
  expiryDate: Date;
  active: boolean;
  refunded: boolean;
  autoRenewStatus: boolean;
  billingRetry: boolean;
  environment: "Production" | "Sandbox";
};

async function requestVerification(url: string, receipt: string): Promise<VerifyReceiptResponse> {
  const sharedSecret = process.env["APPLE_SHARED_SECRET"];
  if (!sharedSecret) {
    throw new AppleReceiptError(
      "APPLE_SHARED_SECRET is not configured on the backend.",
      "apple_configuration_error",
      503,
    );
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      "receipt-data": receipt,
      password: sharedSecret,
      "exclude-old-transactions": false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new AppleReceiptError(
      `Apple receipt service returned HTTP ${response.status}.`,
      "apple_receipt_service_unavailable",
      502,
    );
  }
  return (await response.json()) as VerifyReceiptResponse;
}

function toDate(value: string | undefined, label: string) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new AppleReceiptError(`Apple receipt is missing ${label}.`, "invalid_apple_receipt");
  }
  return new Date(milliseconds);
}

export async function verifyAppleReceipt(receipt: string): Promise<VerifiedAppleReceipt> {
  try {
    let result = await requestVerification(PRODUCTION_VERIFY_URL, receipt);
    let environment: "Production" | "Sandbox" = "Production";

    // 21007 is Apple's explicit instruction to retry a sandbox receipt in sandbox.
    if (result.status === 21007) {
      result = await requestVerification(SANDBOX_VERIFY_URL, receipt);
      environment = "Sandbox";
    }

    // 21006 is a valid receipt whose subscription has expired. It is useful for
    // restore and entitlement reconciliation, so continue and mark it inactive.
    if (result.status !== 0 && result.status !== 21006) {
      throw new AppleReceiptError(
        `Apple rejected the receipt with status ${result.status ?? "unknown"}.`,
        "apple_receipt_verification_failed",
        400,
        result.status,
      );
    }
    if (result.receipt?.bundle_id !== APPLE_BUNDLE_ID) {
      throw new AppleReceiptError("Receipt bundle ID does not match this app.", "apple_bundle_mismatch");
    }

    const transactions = [
      ...(result.latest_receipt_info || []),
      ...(result.receipt?.in_app || []),
    ].filter((item) => item.product_id === APPLE_PRODUCT_ID);
    const latest = transactions.sort(
      (a, b) => Number(b.expires_date_ms || 0) - Number(a.expires_date_ms || 0),
    )[0];

    if (!latest) {
      throw new AppleReceiptError("Receipt does not contain the configured subscription.", "apple_product_mismatch");
    }
    if (!latest.transaction_id || !latest.original_transaction_id) {
      throw new AppleReceiptError("Receipt transaction identifiers are missing.", "invalid_apple_receipt");
    }

    const purchaseDate = toDate(latest.purchase_date_ms, "purchase date");
    const expiryDate = toDate(latest.expires_date_ms, "expiry date");
    const renewal = (result.pending_renewal_info || []).find(
      (item) =>
        item.original_transaction_id === latest.original_transaction_id ||
        item.product_id === APPLE_PRODUCT_ID ||
        item.auto_renew_product_id === APPLE_PRODUCT_ID,
    );
    const refunded = Boolean(latest.cancellation_date_ms);
    const graceExpiryMilliseconds = Number(renewal?.grace_period_expires_date_ms || 0);
    const effectiveExpiryDate =
      Number.isFinite(graceExpiryMilliseconds) &&
      graceExpiryMilliseconds > expiryDate.getTime()
        ? new Date(graceExpiryMilliseconds)
        : expiryDate;
    const verified: VerifiedAppleReceipt = {
      productId: latest.product_id || APPLE_PRODUCT_ID,
      transactionId: latest.transaction_id,
      originalTransactionId: latest.original_transaction_id,
      purchaseDate,
      expiryDate: effectiveExpiryDate,
      active: !refunded && effectiveExpiryDate.getTime() > Date.now(),
      refunded,
      autoRenewStatus: renewal ? renewal.auto_renew_status === "1" : true,
      billingRetry: renewal?.is_in_billing_retry_period === "1",
      environment: result.environment === "Sandbox" ? "Sandbox" : environment,
    };

    logger.info(
      {
        environment: verified.environment,
        productId: verified.productId,
        originalTransactionId: verified.originalTransactionId,
        expiryDate: verified.expiryDate,
        active: verified.active,
      },
      "Apple receipt verification succeeded",
    );
    return verified;
  } catch (error) {
    logger.warn(
      {
        code: error instanceof AppleReceiptError ? error.code : "apple_receipt_verification_failed",
        appleStatus: error instanceof AppleReceiptError ? error.appleStatus : undefined,
        message: error instanceof Error ? error.message : "Unknown Apple receipt error",
      },
      "Apple receipt verification failed",
    );
    if (error instanceof AppleReceiptError) throw error;
    throw new AppleReceiptError(
      "Apple receipt verification could not be completed.",
      "apple_receipt_verification_failed",
      502,
    );
  }
}
