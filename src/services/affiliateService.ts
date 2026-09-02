import { AffiliateMilestone, AffiliateNotification, AffiliatePurchase, AffiliateReferral, AffiliateSettings } from "@api/db";

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
  return AffiliateReferral.findOneAndUpdate(
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
}

export async function recordAffiliatePurchase(input: { userId: string; subscriptionId: string; planId: string; transactionId: string; platform: "WEB" | "ANDROID" | "IOS"; paymentGateway: string; amount: number; purchaseAt?: Date }) {
  const settings = await affiliateSettings();
  const cutoff = windowCutoff(settings.attributionWindowDays);
  const referral = await AffiliateReferral.findOne({ userId: input.userId, attributionStatus: "ATTRIBUTED", clickAt: { $gte: cutoff }, conversionStatus: { $in: ["PENDING", "SUCCESSFUL"] } }).sort(settings.attributionModel === "FIRST_CLICK" ? { clickAt: 1 } : { clickAt: -1 });
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
