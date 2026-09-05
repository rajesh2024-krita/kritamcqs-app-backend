import crypto from "node:crypto";
import { Affiliate, AffiliateActivityLog, AffiliateEventTemplate, AffiliateMilestone, AffiliateNotification, AffiliatePurchase, AffiliateReferral, AffiliateSettings } from "@api/db";

const renderEventValue = (source: unknown, values: Record<string, unknown>) => String(source || "").replace(/{{\s*([\w.]+)\s*}}/g, (_match, key) => String(values[key] ?? ""));
export async function emitAffiliateEvent(event: string, affiliateId: string, values: Record<string, unknown> = {}) {
  const [template, affiliate, settings] = await Promise.all([AffiliateEventTemplate.findOne({ event }).lean(), Affiliate.findById(affiliateId).lean(), affiliateSettings()]);
  if (!affiliate) return null;
  const variables = { affiliate_name: affiliate.affiliateName, affiliate_code: affiliate.affiliateCode, ...values };
  let notification = null;
  if (settings.appNotificationEnabled !== false && template?.notificationEnabled !== false && ["AFFILIATE", "BOTH", undefined].includes(template?.recipient)) notification = await AffiliateNotification.create({ affiliateId, notificationType: event, title: renderEventValue(template?.title || event.replaceAll("_", " "), variables), message: renderEventValue(template?.message || `Affiliate event: ${event.replaceAll("_", " ")}`, variables), reportData: values, appNotificationStatus: "SENT", emailStatus: settings.emailEnabled === false || template?.emailEnabled === false ? "DISABLED" : "QUEUED" });
  await AffiliateActivityLog.create({ activityId: crypto.randomUUID(), userType: "SYSTEM", affiliateId, action: event, module: "EVENT_ENGINE", description: `Central affiliate event processed: ${event}`, metadata: { values, notificationId: notification?._id } });
  return notification;
}

export async function affiliateSettings() {
  return AffiliateSettings.findOneAndUpdate({ key: "default" }, { $setOnInsert: { key: "default" } }, { upsert: true, new: true });
}

function windowCutoff(days: number) {
  return new Date(Date.now() - Number(days || 30) * 86400000);
}

function commission(amount: number, rate: number) {
  return Math.round(Number(amount || 0) * Number(rate || 0)) / 100;
}

export async function attachReferralToUser(referralClickId: string, userId: string, registrationAt = new Date(), mode: "registration" | "login" = "registration") {
  if (!referralClickId || !userId) return null;
  const settings = await affiliateSettings();
  const cutoff = windowCutoff(settings.attributionWindowDays);
  const click = await AffiliateReferral.findOne({ referralClickId, clickAt: { $gte: cutoff } });
  if (!click) return null;

  const existingConverted = await AffiliateReferral.findOne({ userId, conversionStatus: "SUCCESSFUL" }).sort({ purchaseAt: 1, clickAt: 1 });
  if (existingConverted) {
    if (!click.userId) {
      await AffiliateReferral.updateOne(
        { _id: click._id },
        { $set: { userId, attributedAt: new Date(), attributionStatus: "REPLACED", registrationStatus: mode === "registration" ? "REGISTERED" : "EXISTING_USER", loginStatus: "LOGGED_IN", loginAt: new Date(), userType: mode === "registration" ? "NEW_USER" : "EXISTING_USER", conversionStatus: "DUPLICATE" } },
      );
    }
    return existingConverted;
  }

  if (mode === "login" && settings.allowExistingUserAttribution === false) {
    await AffiliateReferral.updateOne(
      { _id: click._id },
      { $set: { userId, attributedAt: new Date(), registrationStatus: "EXISTING_USER", loginStatus: "LOGGED_IN", loginAt: new Date(), userType: "EXISTING_USER", attributionStatus: "EXPIRED" } },
    );
    return null;
  }

  const activeForUser = await AffiliateReferral.findOne({ userId, attributionStatus: { $in: ["ATTRIBUTED", "ACTIVE"] }, conversionStatus: { $ne: "SUCCESSFUL" } }).sort(settings.attributionModel === "FIRST_CLICK" ? { clickAt: 1 } : { clickAt: -1 });
  if (activeForUser && String(activeForUser._id) !== String(click._id) && settings.attributionModel !== "LAST_CLICK") return activeForUser;
  if (activeForUser && String(activeForUser._id) !== String(click._id)) {
    await AffiliateReferral.updateOne({ _id: activeForUser._id }, { $set: { attributionStatus: "REPLACED" } });
  }

  const now = new Date();
  const attributed = await AffiliateReferral.findOneAndUpdate(
    { _id: click._id },
    {
      $set: {
        userId,
        attributedAt: now,
        attributionStatus: "ATTRIBUTED",
        registrationStatus: mode === "registration" ? "REGISTERED" : "EXISTING_USER",
        ...(mode === "registration" ? { registrationAt } : {}),
        loginStatus: "LOGGED_IN",
        loginAt: now,
        userType: mode === "registration" ? "NEW_USER" : "EXISTING_USER",
        conversionStatus: "PENDING",
      },
    },
    { new: true },
  );
  if (attributed) await emitAffiliateEvent(mode === "registration" ? "USER_REGISTERED" : "USER_LOGGED_IN", String(attributed.affiliateId), { referral_id: String(attributed._id), user_id: userId });
  return attributed;
}

async function activeAttributedReferral(userId: string) {
  const settings = await affiliateSettings();
  const cutoff = windowCutoff(settings.attributionWindowDays);
  return AffiliateReferral.findOne({ userId, attributionStatus: "ATTRIBUTED", clickAt: { $gte: cutoff }, conversionStatus: { $in: ["PENDING", "SUCCESSFUL"] } }).sort(settings.attributionModel === "FIRST_CLICK" ? { clickAt: 1 } : { clickAt: -1 });
}

export async function recordAffiliateSubscriptionAttempt(input: { userId: string; subscriptionId?: string; planId?: string; transactionId?: string; platform: "WEB" | "ANDROID" | "IOS"; paymentGateway?: string; amount?: number; status: "PENDING" | "FAILED" | "CANCELLED"; attemptedAt?: Date; reason?: string }) {
  const referral = await activeAttributedReferral(input.userId);
  if (!referral) return null;

  const attemptedAt = input.attemptedAt || new Date();
  const transactionId = String(input.transactionId || input.subscriptionId || `${input.status}:${input.userId}:${input.planId || "subscription"}`);
  const paymentStatus = input.status;
  const conversionStatus = input.status === "PENDING" ? "PENDING" : input.status;
  const subscriptionStatus = input.status === "PENDING" ? "PENDING" : input.status;

  const purchase = await AffiliatePurchase.findOneAndUpdate(
    { transactionId },
    {
      $set: {
        paymentStatus,
        subscriptionStatus,
        conversionStatus,
        purchaseAt: attemptedAt,
      },
      $setOnInsert: {
        userId: input.userId,
        affiliateId: referral.affiliateId,
        referralId: referral._id,
        subscriptionId: input.subscriptionId || transactionId,
        planId: input.planId || "",
        platform: input.platform,
        transactionId,
        paymentGateway: input.paymentGateway || "",
        amount: Number(input.amount || 0),
        commissionRate: 0,
        commissionAmount: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await AffiliateReferral.updateOne({ _id: referral._id }, { $set: {
    purchaseAt: attemptedAt,
    subscriptionPlanId: input.planId || referral.subscriptionPlanId,
    purchaseAmount: Number(input.amount || referral.purchaseAmount || 0),
    transactionId,
    paymentGateway: input.paymentGateway || referral.paymentGateway,
    paymentStatus,
    subscriptionStatus,
    purchaseStatus: paymentStatus,
    conversionStatus,
  } });

  await emitAffiliateEvent(
    input.status === "PENDING" ? "SUBSCRIPTION_PENDING" : input.status === "FAILED" ? "SUBSCRIPTION_FAILED" : "SUBSCRIPTION_CANCELLED",
    String(referral.affiliateId),
    { referral_id: String(referral._id), plan_id: input.planId || "", transaction_id: transactionId, reason: input.reason || "" },
  );
  return purchase;
}

export async function recordAffiliatePurchase(input: { userId: string; subscriptionId: string; planId: string; transactionId: string; platform: "WEB" | "ANDROID" | "IOS"; paymentGateway: string; amount: number; purchaseAt?: Date }) {
  const settings = await affiliateSettings();
  const referral = await activeAttributedReferral(input.userId);
  if (!referral) return null;
  const commissionRate = Number(settings.commissionRatePercent || 0);
  const commissionAmount = commission(input.amount, commissionRate);
  const purchase = await AffiliatePurchase.findOneAndUpdate(
    { transactionId: input.transactionId },
    { $setOnInsert: { ...input, affiliateId: referral.affiliateId, referralId: referral._id, paymentStatus: "PAID", subscriptionStatus: "ACTIVE", conversionStatus: "SUCCESSFUL", commissionRate, commissionAmount, purchaseAt: input.purchaseAt || new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true },
  );
  const doc: any = (purchase as any)?.value || purchase;
  await AffiliateReferral.updateOne({ _id: referral._id }, { $set: { purchaseAt: doc.purchaseAt, subscriptionPlanId: input.planId, purchaseAmount: input.amount, transactionId: input.transactionId, paymentGateway: input.paymentGateway, paymentStatus: "PAID", subscriptionStatus: "ACTIVE", purchaseStatus: "PAID", conversionStatus: "SUCCESSFUL", commissionRate, commissionAmount } });
  await emitAffiliateEvent("SUBSCRIPTION_PURCHASED", String(referral.affiliateId), { purchase_amount: input.amount, commission_amount: commissionAmount, plan_id: input.planId, transaction_id: input.transactionId });
  await processMilestones(String(referral.affiliateId));
  return doc;
}

async function processMilestones(affiliateId: string) {
  const settings = await affiliateSettings();
  const count = await AffiliatePurchase.countDocuments({ affiliateId, paymentStatus: "PAID", subscriptionStatus: { $ne: "REFUNDED" } });
  const step = Number(settings.milestoneCount || 10);
  const reached = settings.repeatMilestone ? Math.floor(count / step) * step : (count >= step ? step : 0);
  if (!reached) return;
  try {
    await AffiliateMilestone.create({ affiliateId, milestoneCount: reached, emailStatus: settings.emailEnabled ? "PENDING" : "DISABLED", notificationStatus: settings.appNotificationEnabled ? "CREATED" : "DISABLED" });
    await AffiliateNotification.create({ affiliateId, notificationType: "MILESTONE", title: "Purchase milestone reached", message: `Congratulations! You have generated ${reached} successful subscriptions.`, reportData: { successfulPurchases: count, milestone: reached }, appNotificationStatus: "CREATED" });
  } catch (error: any) { if (error?.code !== 11000) throw error; }
}

export async function affiliateMetrics(match: Record<string, unknown> = {}) {
  const purchaseMatch: Record<string, unknown> = {};
  if (match.affiliateId) purchaseMatch.affiliateId = match.affiliateId;
  if (match.platform) purchaseMatch.platform = match.platform;
  if (match.purchaseAt) purchaseMatch.purchaseAt = match.purchaseAt;
  if (match.clickAt) purchaseMatch.purchaseAt = match.clickAt;
  purchaseMatch.paymentStatus = "PAID";
  purchaseMatch.subscriptionStatus = { $ne: "REFUNDED" };
  const [clicks, uniqueClicks, installs, existingAppUsers, registrations, existingUserLogins, premiumPurchases, pendingConversions, failedPurchases, purchases] = await Promise.all([
    AffiliateReferral.countDocuments(match),
    AffiliateReferral.distinct("referralClickId", match),
    AffiliateReferral.countDocuments({ ...match, installationStatus: "NEW_INSTALL" }),
    AffiliateReferral.countDocuments({ ...match, installationStatus: "EXISTING_APP_USER" }),
    AffiliateReferral.countDocuments({ ...match, registrationStatus: "REGISTERED" }),
    AffiliateReferral.countDocuments({ ...match, registrationStatus: "EXISTING_USER", loginStatus: "LOGGED_IN" }),
    AffiliateReferral.countDocuments({ ...match, purchaseStatus: "PAID" }),
    AffiliateReferral.countDocuments({ ...match, conversionStatus: "PENDING", userId: { $exists: true } }),
    AffiliateReferral.countDocuments({ ...match, purchaseStatus: { $in: ["FAILED", "CANCELLED"] } }),
    AffiliatePurchase.aggregate([{ $match: purchaseMatch }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" }, commission: { $sum: "$commissionAmount" } } }]),
  ]);
  const successfulPurchases = Number(purchases[0]?.count || 0); const totalPurchaseAmount = Number(purchases[0]?.amount || 0);
  return { clicks, totalClicks: clicks, uniqueClicks: uniqueClicks.length, newAppInstallations: installs, existingAppUsers, registrations, existingUserLogins, premiumPurchases, successfulConversions: successfulPurchases, pendingConversions, failedOrCancelledPurchases: failedPurchases, successfulPurchases, totalPurchaseAmount, commissionEarned: Number(purchases[0]?.commission || 0), averagePurchaseValue: successfulPurchases ? totalPurchaseAmount / successfulPurchases : 0, conversionRate: clicks ? successfulPurchases / clicks * 100 : 0 };
}
