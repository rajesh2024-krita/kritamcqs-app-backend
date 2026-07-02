import type { Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middlewares/auth";
import {
  AppleReceiptError,
  APPLE_PRODUCT_ID,
  verifyAppleReceipt,
} from "../services/appleReceiptService";
import {
  saveVerifiedAppleSubscription,
  SubscriptionOwnershipError,
} from "../services/appleSubscriptionService";

const verifySchema = z.object({
  productId: z.string().min(1),
  transactionId: z.string().min(1),
  originalTransactionId: z.string().min(1),
  receipt: z.string().min(20).max(10_000_000),
  platform: z.literal("ios"),
});

const restoreSchema = z.object({
  receipt: z.string().min(20).max(10_000_000),
});

function respondWithError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      success: false,
      error: "invalid_request",
      message: "Invalid Apple purchase payload.",
      details: error.flatten().fieldErrors,
    });
    return;
  }
  if (error instanceof SubscriptionOwnershipError) {
    res.status(409).json({
      success: false,
      error: "subscription_already_linked",
      message: error.message,
    });
    return;
  }
  if (error instanceof AppleReceiptError) {
    res.status(error.httpStatus).json({
      success: false,
      error: error.code,
      message: error.message,
    });
    return;
  }
  res.status(500).json({
    success: false,
    error: "apple_iap_error",
    message: "The App Store purchase could not be processed.",
  });
}

export async function verifyApplePurchase(req: AuthenticatedRequest, res: Response) {
  try {
    const body = verifySchema.parse(req.body);
    if (body.productId !== APPLE_PRODUCT_ID) {
      throw new AppleReceiptError("Unsupported Apple subscription product.", "apple_product_mismatch");
    }

    const verified = await verifyAppleReceipt(body.receipt);
    if (verified.originalTransactionId !== body.originalTransactionId) {
      throw new AppleReceiptError(
        "Purchase does not match the verified App Store receipt.",
        "apple_transaction_mismatch",
      );
    }
    if (verified.transactionId !== body.transactionId) {
      req.log.info(
        {
          suppliedTransactionId: body.transactionId,
          verifiedTransactionId: verified.transactionId,
          originalTransactionId: verified.originalTransactionId,
        },
        "Using the latest transaction from the verified Apple receipt",
      );
    }

    await saveVerifiedAppleSubscription(req.userId!, body.receipt, verified);
    res.json({
      success: true,
      subscriptionActive: verified.active,
      expiresAt: verified.expiryDate,
    });
  } catch (error) {
    req.log.warn(
      { err: error, userId: req.userId },
      "Apple purchase verification request failed",
    );
    respondWithError(res, error);
  }
}

export async function restoreApplePurchase(req: AuthenticatedRequest, res: Response) {
  try {
    const body = restoreSchema.parse(req.body);
    const verified = await verifyAppleReceipt(body.receipt);
    await saveVerifiedAppleSubscription(req.userId!, body.receipt, verified);

    res.json({
      success: true,
      subscriptionActive: verified.active,
      expiresAt: verified.expiryDate,
      productId: verified.productId,
      originalTransactionId: verified.originalTransactionId,
    });
  } catch (error) {
    req.log.warn({ err: error, userId: req.userId }, "Apple purchase restore failed");
    respondWithError(res, error);
  }
}
