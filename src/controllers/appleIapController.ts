import type { Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { SubscriptionPlan, User } from "@api/db";
import type { AuthenticatedRequest } from "../middlewares/auth";
import {
  AppleReceiptError,
  APPLE_PRODUCT_ID,
  verifyAppleReceipt,
} from "../services/appleReceiptService";
import { verifyAppleTransaction } from "../services/appleNotificationService";
import {
  saveVerifiedAppleSubscription,
  SubscriptionOwnershipError,
} from "../services/appleSubscriptionService";

const appleProofFields = {
  receipt: z.string().min(20).max(10_000_000).optional(),
  signedTransactionInfo: z.string().min(20).max(10_000_000).optional(),
};

const verifySchema = z.object({
  planId: z.string().min(1),
  productId: z.string().min(1),
  transactionId: z.string().min(1),
  originalTransactionId: z.string().min(1),
  ...appleProofFields,
  platform: z.literal("ios"),
}).refine((body) => Boolean(body.receipt || body.signedTransactionInfo), {
  message: "An Apple receipt or signed transaction is required.",
});

const restoreSchema = z.object(appleProofFields).refine(
  (body) => Boolean(body.receipt || body.signedTransactionInfo),
  { message: "An Apple receipt or signed transaction is required." },
);

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
    const productFilters: Record<string, unknown>[] = [{ billingProductId: body.productId }];
    if (body.productId === APPLE_PRODUCT_ID) {
      productFilters.push({ billingProductId: { $exists: false } }, { billingProductId: "" });
    }
    const plan = await SubscriptionPlan.findOne({
      planId: body.planId,
      platform: "ios",
      $and: [{ $or: productFilters }],
      $or: [{ status: "active" }, { active: true }],
    });
    if (!plan) {
      throw new AppleReceiptError("Unsupported Apple subscription product.", "apple_product_mismatch");
    }

    const verified = body.signedTransactionInfo
      ? await verifyAppleTransaction(body.signedTransactionInfo, body.productId)
      : await verifyAppleReceipt(body.receipt!, body.productId);
    if (verified.productId !== body.productId) {
      throw new AppleReceiptError("Purchase does not match the selected iOS plan.", "apple_product_mismatch");
    }
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

    await saveVerifiedAppleSubscription(
      req.userId!,
      body.receipt || body.signedTransactionInfo!,
      verified,
    );
    res.json({
      success: true,
      subscriptionActive: verified.active,
      expiresAt: verified.expiryDate,
      planId: plan.planId,
      planName: plan.name,
      productId: verified.productId,
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
    const configuredPlans = await SubscriptionPlan.find({
      platform: "ios",
      billingProductId: { $exists: true, $ne: "" },
    }).select("billingProductId");
    const productIds = [
      ...new Set([
        ...configuredPlans.map((plan) => String(plan.billingProductId || "")).filter(Boolean),
        APPLE_PRODUCT_ID,
      ]),
    ];
    const verified = body.signedTransactionInfo
      ? await verifyAppleTransaction(body.signedTransactionInfo, productIds)
      : await verifyAppleReceipt(body.receipt!, productIds);
    await saveVerifiedAppleSubscription(
      req.userId!,
      body.receipt || body.signedTransactionInfo!,
      verified,
    );

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

export async function getAppleAppAccountToken(req: AuthenticatedRequest, res: Response) {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      res.status(404).json({ success: false, error: "user_not_found", message: "User not found." });
      return;
    }
    if (!user.appleAppAccountToken) {
      user.appleAppAccountToken = crypto.randomUUID();
      await user.save();
    }
    res.json({ success: true, appAccountToken: user.appleAppAccountToken });
  } catch (error) {
    req.log.warn({ err: error, userId: req.userId }, "Apple app account token creation failed");
    res.status(500).json({
      success: false,
      error: "apple_account_token_error",
      message: "Unable to prepare the App Store purchase.",
    });
  }
}
