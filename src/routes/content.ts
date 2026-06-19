import { Router, type IRouter } from "express";
import { DashboardCarouselBanner, ExplanationPreviewTemplate, OfferTimerSettings, Subscription, SubscriptionFreeCard, SubscriptionPageTemplate, SubscriptionStatCard, User } from "@api/db";

const router: IRouter = Router();

function mapId(item: any) {
  const raw = typeof item?.toJSON === "function" ? item.toJSON() : item;
  return {
    ...raw,
    id: String(raw?.id || raw?._id || ""),
    _id: undefined,
    __v: undefined,
  };
}

router.get("/dashboard-carousel", async (_req, res) => {
  const banners = await DashboardCarouselBanner.find({ enabled: true })
    .sort({ displayOrder: 1, createdAt: 1 })
    .lean();
  res.json({ banners: banners.map(mapId) });
});

router.get("/subscription-page-template", async (_req, res) => {
  const template = await SubscriptionPageTemplate.findOne({ status: "published" })
    .sort({ publishedAt: -1, updatedAt: -1 })
    .lean();
  res.json({ template: template ? mapId(template) : null });
});

async function resolveStatValue(card: any) {
  if (card.valueType === "text") return null;
  if (card.valueMode !== "live") return Number(card.manualValue || 0);

  if (card.liveSource === "premiumUsers") {
    return User.countDocuments({ isPremium: true });
  }
  if (card.liveSource === "subscriptions") {
    return Subscription.countDocuments({ status: "active" });
  }
  return User.countDocuments();
}

router.get("/subscription-stat-cards", async (_req, res) => {
  const cards = await SubscriptionStatCard.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  const data = await Promise.all(cards.map(async (card) => ({
    id: String(card._id),
    key: card.key,
    label: card.label,
    valueType: card.valueType || "number",
    valueMode: card.valueMode || "manual",
    value: await resolveStatValue(card),
    text: card.valueType === "text" ? String(card.manualText || card.label || "") : "",
    suffix: card.suffix || "",
    iconKey: card.iconKey || "users",
    sortOrder: Number(card.sortOrder || 0),
  })));
  res.json({ cards: data });
});

router.get("/subscription-free-cards", async (_req, res) => {
  const cards = await SubscriptionFreeCard.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  res.json({
    cards: cards.map((card) => ({
      id: String(card._id),
      key: card.key,
      title: card.title,
      subtitle: card.subtitle || "",
      items: Array.isArray(card.items) ? card.items.filter(Boolean) : [],
      sortOrder: Number(card.sortOrder || 0),
    })),
  });
});

router.get("/explanation-preview-template", async (_req, res) => {
  const template = await ExplanationPreviewTemplate.findOne({ status: "published" })
    .sort({ publishedAt: -1, updatedAt: -1 })
    .lean();
  res.json({ template: template ? mapId(template) : null });
});

router.get("/offer-timer", async (_req, res) => {
  try {
    const settings = await OfferTimerSettings.findOne({ key: "app-offer-timer" }).lean();
    res.json({ data: settings ? mapId(settings) : null });
  } catch (error) {
    console.error("Failed to load offer timer settings", error);
    res.json({ data: null });
  }
});

export default router;
