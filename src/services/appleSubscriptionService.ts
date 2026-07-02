import {
  Subscription,
  User,
  UserSubscription,
  type AppleSubscriptionStatus,
  type IUserSubscription,
} from "@api/db";
import { logger } from "../lib/logger";
import type { VerifiedAppleReceipt } from "./appleReceiptService";

export const APPLE_PREMIUM_PLAN = "Premium Plan – 6 Months";

export class SubscriptionOwnershipError extends Error {}

export async function syncUserPremiumEntitlement(userId: string) {
  const now = new Date();
  const [appleEntitlement, androidEntitlement] = await Promise.all([
    UserSubscription.findOne({
      userId,
      subscriptionStatus: { $in: ["active", "failed", "cancelled"] },
      expiryDate: { $gt: now },
    }).sort({ expiryDate: -1 }),
    Subscription.findOne({
      userId,
      status: "active",
      $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gt: now } }],
    }).sort({ endDate: -1, createdAt: -1 }),
  ]);

  if (appleEntitlement) {
    await User.findByIdAndUpdate(userId, {
      $set: {
        isPremium: true,
        premiumPlan: APPLE_PREMIUM_PLAN,
        premiumExpiry: appleEntitlement.expiryDate,
        premiumExpiresAt: appleEntitlement.expiryDate,
        paymentPlatform: "ios",
      },
    });
    return true;
  }

  if (androidEntitlement) {
    // Preserve an existing Android/Razorpay entitlement. Apple lifecycle events
    // must never revoke access bought through another platform.
    await User.findByIdAndUpdate(userId, {
      $set: {
        isPremium: true,
        premiumExpiry: androidEntitlement.endDate,
        premiumExpiresAt: androidEntitlement.endDate,
        paymentPlatform: "android",
      },
    });
    return true;
  }

  await User.findByIdAndUpdate(userId, {
    $set: { isPremium: false },
    $unset: {
      premiumPlan: 1,
      premiumExpiry: 1,
      premiumExpiresAt: 1,
      paymentPlatform: 1,
    },
  });
  logger.info({ userId }, "Premium access revoked after entitlement reconciliation");
  return false;
}

function statusFromReceipt(receipt: VerifiedAppleReceipt): AppleSubscriptionStatus {
  if (receipt.refunded) return "refunded";
  if (receipt.active) return receipt.autoRenewStatus ? "active" : "cancelled";
  if (receipt.billingRetry) return "failed";
  return "expired";
}

export async function saveVerifiedAppleSubscription(
  userId: string,
  receiptData: string,
  receipt: VerifiedAppleReceipt,
): Promise<IUserSubscription> {
  const existing = await UserSubscription.findOne({
    originalTransactionId: receipt.originalTransactionId,
  }).select("+receiptData");

  if (existing && existing.userId !== userId) {
    throw new SubscriptionOwnershipError(
      "This App Store subscription is already linked to another account.",
    );
  }

  const subscription = await UserSubscription.findOneAndUpdate(
    { originalTransactionId: receipt.originalTransactionId },
    {
      $set: {
        userId,
        productId: receipt.productId,
        transactionId: receipt.transactionId,
        receiptData,
        purchaseDate: receipt.purchaseDate,
        expiryDate: receipt.expiryDate,
        subscriptionStatus: statusFromReceipt(receipt),
        autoRenewStatus: receipt.autoRenewStatus,
        platform: "ios",
        environment: receipt.environment,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await syncUserPremiumEntitlement(userId);
  logger.info(
    {
      userId,
      originalTransactionId: receipt.originalTransactionId,
      transactionId: receipt.transactionId,
      expiryDate: receipt.expiryDate,
      status: subscription.subscriptionStatus,
    },
    "Apple subscription updated",
  );
  return subscription;
}

export async function updateSubscriptionFromWebhook(params: {
  userId?: string;
  originalTransactionId: string;
  transactionId?: string;
  productId?: string;
  purchaseDate?: Date;
  expiryDate?: Date;
  status?: AppleSubscriptionStatus;
  autoRenewStatus?: boolean;
  environment?: "Production" | "Sandbox";
  latestWebhookEvent: {
    type?: string;
    subtype?: string;
    notificationUUID?: string;
    signedDate?: Date;
  };
}) {
  const subscription = await UserSubscription.findOne({
    originalTransactionId: params.originalTransactionId,
  });
  if (!subscription) {
    if (
      !params.userId ||
      !params.transactionId ||
      !params.productId ||
      !params.purchaseDate ||
      !params.expiryDate ||
      !params.status
    ) {
      return null;
    }
    const created = await UserSubscription.create({
      userId: params.userId,
      originalTransactionId: params.originalTransactionId,
      transactionId: params.transactionId,
      productId: params.productId,
      purchaseDate: params.purchaseDate,
      expiryDate: params.expiryDate,
      subscriptionStatus: params.status,
      autoRenewStatus: params.autoRenewStatus ?? true,
      platform: "ios",
      environment: params.environment,
      latestWebhookEvent: params.latestWebhookEvent,
    });
    await syncUserPremiumEntitlement(params.userId);
    logger.info(
      {
        userId: params.userId,
        originalTransactionId: params.originalTransactionId,
        event: params.latestWebhookEvent.type,
      },
      "Apple subscription created from verified webhook",
    );
    return created;
  }

  if (params.transactionId) subscription.transactionId = params.transactionId;
  if (params.productId) subscription.productId = params.productId;
  if (params.purchaseDate) subscription.purchaseDate = params.purchaseDate;
  if (params.expiryDate) subscription.expiryDate = params.expiryDate;
  if (params.status) subscription.subscriptionStatus = params.status;
  if (typeof params.autoRenewStatus === "boolean") {
    subscription.autoRenewStatus = params.autoRenewStatus;
  }
  if (params.environment) subscription.environment = params.environment;
  subscription.latestWebhookEvent = params.latestWebhookEvent;
  await subscription.save();
  await syncUserPremiumEntitlement(subscription.userId);

  logger.info(
    {
      userId: subscription.userId,
      originalTransactionId: subscription.originalTransactionId,
      status: subscription.subscriptionStatus,
      expiryDate: subscription.expiryDate,
      event: params.latestWebhookEvent.type,
    },
    "Apple webhook subscription update applied",
  );
  return subscription;
}
