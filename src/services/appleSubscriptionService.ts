import {
  Subscription,
  SubscriptionPlan,
  User,
  UserSubscription,
  type AppleSubscriptionStatus,
  type IUserSubscription,
} from "@api/db";
import { logger } from "../lib/logger";
import { generateInvoiceForSubscription } from "../lib/invoices";
import { APPLE_PRODUCT_ID, type VerifiedAppleReceipt } from "./appleReceiptService";

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
      $and: [
        { $or: [{ platform: "android" }, { platform: { $exists: false } }] },
        { $or: [{ paymentProvider: "razorpay" }, { paymentProvider: { $exists: false } }] },
      ],
      status: "active",
      $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gt: now } }],
    }).sort({ endDate: -1, createdAt: -1 }),
  ]);

  if (appleEntitlement) {
    const productFilters: Record<string, unknown>[] = [
      { billingProductId: appleEntitlement.productId, platform: "ios" },
    ];
    if (appleEntitlement.productId === APPLE_PRODUCT_ID) {
      productFilters.push(
        { platform: "ios", billingProductId: { $exists: false } },
        { platform: "ios", billingProductId: "" },
      );
    }
    const configuredPlan = await SubscriptionPlan.findOne({
      $or: [
        ...(appleEntitlement.planId ? [{ planId: appleEntitlement.planId, platform: "ios" }] : []),
        ...productFilters,
      ],
    }).select("planId name");
    await User.findByIdAndUpdate(userId, {
      $set: {
        isPremium: true,
        premiumPlan: configuredPlan?.name || APPLE_PREMIUM_PLAN,
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
  if (receipt.active) {
    return receipt.nonRenewing || receipt.autoRenewStatus ? "active" : "cancelled";
  }
  if (receipt.billingRetry) return "failed";
  return "expired";
}

export async function saveVerifiedAppleSubscription(
  userId: string,
  receiptData: string | undefined,
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
  const receiptProductFilters: Record<string, unknown>[] = [{ billingProductId: receipt.productId }];
  if (receipt.productId === APPLE_PRODUCT_ID) {
    receiptProductFilters.push({ billingProductId: { $exists: false } }, { billingProductId: "" });
  }
  const configuredPlan = await SubscriptionPlan.findOne({
    platform: "ios",
    $or: receiptProductFilters,
  }).select("planId");

  const subscription = await UserSubscription.findOneAndUpdate(
    { originalTransactionId: receipt.originalTransactionId },
    {
      $set: {
        userId,
        planId: configuredPlan?.planId,
        productId: receipt.productId,
        transactionId: receipt.transactionId,
        ...(receiptData ? { receiptData } : {}),
        purchaseDate: receipt.purchaseDate,
        expiryDate: receipt.expiryDate,
        subscriptionStatus: statusFromReceipt(receipt),
        autoRenewStatus: receipt.autoRenewStatus,
        platform: "ios",
        environment: receipt.environment,
        ...(receipt.active
          ? {
              retryPending: false,
              retryCount: 0,
              nextRetryAt: null,
              lastVerificationAt: new Date(),
            }
          : {}),
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

export async function fulfillVerifiedApplePurchase(
  userId: string,
  receiptData: string | undefined,
  receipt: VerifiedAppleReceipt,
) {
  const appleSubscription = await saveVerifiedAppleSubscription(userId, receiptData, receipt);
  if (!receipt.active) {
    return { appleSubscription, purchase: null, invoice: null };
  }

  const plan = await SubscriptionPlan.findOne({
    platform: "ios",
    $or: [
      { billingProductId: receipt.productId },
      ...(receipt.productId === APPLE_PRODUCT_ID
        ? [{ billingProductId: { $exists: false } }, { billingProductId: "" }]
        : []),
    ],
  });
  if (!plan) {
    throw new Error(`No iOS subscription plan is configured for ${receipt.productId}.`);
  }

  const amount = Number(receipt.amount ?? plan.price ?? 0);
  const currency = receipt.currency || "INR";
  const purchase = await Subscription.findOneAndUpdate(
    { appleTransactionId: receipt.transactionId },
    {
      $set: {
        userId,
        planId: plan.planId,
        platform: "ios",
        paymentProvider: "apple",
        appleProductId: receipt.productId,
        appleTransactionId: receipt.transactionId,
        appleOriginalTransactionId: receipt.originalTransactionId,
        appleEnvironment: receipt.environment,
        baseAmount: amount,
        discountAmount: 0,
        taxPercent: 0,
        taxAmount: 0,
        amountBeforeCharges: amount,
        convenienceChargePercent: 0,
        convenienceCharge: 0,
        convenienceChargeGstPercent: 0,
        convenienceChargeGst: 0,
        finalAmount: amount,
        currency,
        amount,
        paymentStatus: "PAID",
        status: "active",
        transactionDate: receipt.purchaseDate,
        startDate: receipt.purchaseDate,
        endDate: receipt.expiryDate,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await User.findByIdAndUpdate(userId, {
    $set: {
      isPremium: true,
      premiumPlan: plan.name,
      premiumExpiry: receipt.expiryDate,
      premiumExpiresAt: receipt.expiryDate,
      paymentPlatform: "ios",
      lastPurchase: {
        subscriptionId: String(purchase._id),
        planId: plan.planId,
        planAmount: amount,
        discountAmount: 0,
        taxAmount: 0,
        convenienceCharge: 0,
        convenienceChargeGst: 0,
        finalAmount: amount,
        currency,
        appleProductId: receipt.productId,
        appleTransactionId: receipt.transactionId,
        appleOriginalTransactionId: receipt.originalTransactionId,
        paymentStatus: "PAID",
        transactionDate: receipt.purchaseDate,
      },
    },
  });

  let invoice = null;
  try {
    invoice = await generateInvoiceForSubscription(String(purchase._id));
    logger.info(
      {
        userId,
        subscriptionId: String(purchase._id),
        transactionId: receipt.transactionId,
        invoiceNumber: invoice.invoiceNumber,
        emailStatus: invoice.emailStatus,
      },
      "Apple purchase fulfilled",
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        userId,
        subscriptionId: String(purchase._id),
        transactionId: receipt.transactionId,
      },
      "Apple purchase activated but automatic invoice generation failed",
    );
  }
  return { appleSubscription, purchase, invoice };
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
  const webhookProductFilters: Record<string, unknown>[] = params.productId
    ? [{ billingProductId: params.productId }]
    : [];
  if (params.productId === APPLE_PRODUCT_ID) {
    webhookProductFilters.push({ billingProductId: { $exists: false } }, { billingProductId: "" });
  }
  const configuredPlan = params.productId
    ? await SubscriptionPlan.findOne({
        platform: "ios",
        $or: webhookProductFilters,
      }).select("planId")
    : null;
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
      planId: configuredPlan?.planId,
      productId: params.productId,
      purchaseDate: params.purchaseDate,
      expiryDate: params.expiryDate,
      subscriptionStatus: params.status,
      autoRenewStatus: params.autoRenewStatus ?? true,
      platform: "ios",
      environment: params.environment,
      latestWebhookEvent: params.latestWebhookEvent,
      retryPending: params.status === "expired" || params.status === "failed",
      retryCount: 0,
      nextRetryAt:
        params.status === "expired" || params.status === "failed"
          ? new Date(Date.now() + 24 * 60 * 60 * 1000)
          : undefined,
    });
    await Subscription.updateMany(
      { paymentProvider: "apple", appleOriginalTransactionId: params.originalTransactionId },
      {
        $set: {
          status: params.status === "active" || params.status === "cancelled" ? "active" : params.status,
          ...(params.expiryDate ? { endDate: params.expiryDate } : {}),
        },
      },
    );
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
  if (params.productId) {
    subscription.productId = params.productId;
    subscription.planId = configuredPlan?.planId;
  }
  if (params.purchaseDate) subscription.purchaseDate = params.purchaseDate;
  if (params.expiryDate) subscription.expiryDate = params.expiryDate;
  if (params.status) subscription.subscriptionStatus = params.status;
  if (params.status === "active") {
    subscription.retryPending = false;
    subscription.retryCount = 0;
    subscription.nextRetryAt = undefined;
  } else if (params.status === "expired" || params.status === "failed") {
    subscription.retryPending = true;
    subscription.retryCount = 0;
    subscription.nextRetryAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
  if (typeof params.autoRenewStatus === "boolean") {
    subscription.autoRenewStatus = params.autoRenewStatus;
  }
  if (params.environment) subscription.environment = params.environment;
  subscription.latestWebhookEvent = params.latestWebhookEvent;
  await subscription.save();
  await Subscription.updateMany(
    { paymentProvider: "apple", appleOriginalTransactionId: params.originalTransactionId },
    {
      $set: {
        status:
          subscription.subscriptionStatus === "active" ||
          subscription.subscriptionStatus === "cancelled"
            ? "active"
            : subscription.subscriptionStatus,
        endDate: subscription.expiryDate,
      },
    },
  );
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
