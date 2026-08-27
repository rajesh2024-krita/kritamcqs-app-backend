import { AffiliateMilestone, AffiliateNotification, AffiliatePurchase, AffiliateReferral, AffiliateSettings } from "@api/db";

export async function affiliateSettings() {
  return AffiliateSettings.findOneAndUpdate({ key: "default" }, { $setOnInsert: { key: "default" } }, { upsert: true, new: true });
}

export async function attachReferralToUser(referralClickId: string, userId: string, registrationAt = new Date()) {
  if (!referralClickId || !userId) return null;
  const settings = await affiliateSettings();
  const cutoff = new Date(Date.now() - Number(settings.attributionWindowDays || 30) * 86400000);
  const existing = await AffiliateReferral.findOne({ userId }).sort({ clickAt: 1 });
  if (existing) return existing;
  return AffiliateReferral.findOneAndUpdate(
    { referralClickId, userId: { $exists: false }, clickAt: { $gte: cutoff } },
    { $set: { userId, registrationAt, conversionStatus: "REGISTERED" } },
    { new: true },
  );
}

export async function recordAffiliatePurchase(input: { userId: string; subscriptionId: string; planId: string; transactionId: string; platform: "WEB" | "ANDROID" | "IOS"; paymentGateway: string; amount: number; purchaseAt?: Date }) {
  const referral = await AffiliateReferral.findOne({ userId: input.userId, conversionStatus: { $in: ["REGISTERED", "CONVERTED"] } }).sort({ registrationAt: 1, clickAt: 1 });
  if (!referral) return null;
  const purchase = await AffiliatePurchase.findOneAndUpdate(
    { transactionId: input.transactionId },
    { $setOnInsert: { ...input, affiliateId: referral.affiliateId, referralId: referral._id, paymentStatus: "PAID", subscriptionStatus: "ACTIVE", purchaseAt: input.purchaseAt || new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true },
  );
  const doc: any = (purchase as any)?.value || purchase;
  await AffiliateReferral.updateOne({ _id: referral._id }, { $set: { purchaseAt: doc.purchaseAt, subscriptionPlanId: input.planId, purchaseAmount: input.amount, transactionId: input.transactionId, paymentGateway: input.paymentGateway, paymentStatus: "PAID", subscriptionStatus: "ACTIVE", conversionStatus: "CONVERTED" } });
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
  const [clicks, registrations, purchases] = await Promise.all([
    AffiliateReferral.countDocuments(match), AffiliateReferral.countDocuments({ ...match, userId: { $exists: true } }),
    AffiliatePurchase.aggregate([{ $match: match }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } } }]),
  ]);
  const successfulPurchases = Number(purchases[0]?.count || 0); const totalPurchaseAmount = Number(purchases[0]?.amount || 0);
  return { clicks, registrations, successfulPurchases, totalPurchaseAmount, averagePurchaseValue: successfulPurchases ? totalPurchaseAmount / successfulPurchases : 0, conversionRate: registrations ? successfulPurchases / registrations * 100 : 0 };
}
