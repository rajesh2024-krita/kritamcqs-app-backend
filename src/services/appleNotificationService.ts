import fs from "node:fs/promises";
import {
  Environment,
  SignedDataVerifier,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { APPLE_BUNDLE_ID } from "./appleReceiptService";

type VerifiedNotification = {
  notification: ResponseBodyV2DecodedPayload;
  transaction?: JWSTransactionDecodedPayload;
  renewal?: JWSRenewalInfoDecodedPayload;
  environment: "Production" | "Sandbox";
};

let verifierPromise:
  | Promise<{
      production?: SignedDataVerifier;
      sandbox: SignedDataVerifier;
    }>
  | undefined;

async function createVerifiers() {
  const certificatePaths = String(process.env["APPLE_ROOT_CA_PATHS"] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!certificatePaths.length) {
    throw new Error("APPLE_ROOT_CA_PATHS is required for Apple webhook signature verification.");
  }

  const roots = await Promise.all(certificatePaths.map((certificatePath) => fs.readFile(certificatePath)));
  const enableOnlineChecks = process.env["APPLE_ENABLE_ONLINE_CHECKS"] !== "false";
  const rawAppId = process.env["APPLE_APP_ID"];
  const appAppleId = rawAppId ? Number(rawAppId) : undefined;
  const production =
    appAppleId && Number.isSafeInteger(appAppleId)
      ? new SignedDataVerifier(
          roots,
          enableOnlineChecks,
          Environment.PRODUCTION,
          APPLE_BUNDLE_ID,
          appAppleId,
        )
      : undefined;

  return {
    production,
    sandbox: new SignedDataVerifier(
      roots,
      enableOnlineChecks,
      Environment.SANDBOX,
      APPLE_BUNDLE_ID,
    ),
  };
}

async function getVerifiers() {
  verifierPromise ||= createVerifiers();
  return verifierPromise;
}

export async function verifyAppleNotification(signedPayload: string): Promise<VerifiedNotification> {
  const verifiers = await getVerifiers();
  const failures: unknown[] = [];

  for (const candidate of [
    verifiers.production
      ? { verifier: verifiers.production, environment: "Production" as const }
      : null,
    { verifier: verifiers.sandbox, environment: "Sandbox" as const },
  ].filter(Boolean) as Array<{
    verifier: SignedDataVerifier;
    environment: "Production" | "Sandbox";
  }>) {
    try {
      const notification = await candidate.verifier.verifyAndDecodeNotification(signedPayload);
      const transaction = notification.data?.signedTransactionInfo
        ? await candidate.verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo)
        : undefined;
      const renewal = notification.data?.signedRenewalInfo
        ? await candidate.verifier.verifyAndDecodeRenewalInfo(notification.data.signedRenewalInfo)
        : undefined;
      return { notification, transaction, renewal, environment: candidate.environment };
    } catch (error) {
      failures.push(error);
    }
  }

  const lastFailure = failures.at(-1);
  throw new Error(
    `Apple signedPayload validation failed: ${
      lastFailure instanceof Error ? lastFailure.message : "invalid signature"
    }`,
  );
}
