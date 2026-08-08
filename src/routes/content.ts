import { Router, type IRouter } from "express";
import { DashboardCarouselBanner, ExplanationPreviewTemplate, OfferTimerSettings, Subscription, SubscriptionFreeCard, SubscriptionPageTemplate, SubscriptionStatCard, User, WebsiteContent } from "@api/db";

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

router.get("/free-user-subscription-cta", async (_req, res) => {
  const item = await WebsiteContent.findOne({ key: "free-user-subscription-cta", status: "published" }).lean();
  const content = item?.content && typeof item.content === "object" ? item.content : {};
  res.json({
    data: {
      enabled: content.enabled !== false,
      eyebrow: content.eyebrow || "NEET & JEE Unlock",
      title: content.title || "Go Premium",
      description: content.description || "Unlock unlimited questions, weak area analysis, and smart revision.",
      imageUrl: content.imageUrl || "",
      ctaText: content.ctaText || "View Plans",
      ctaLink: content.ctaLink || "/subscription",
    },
  });
});

const dynamicCtaCardScreens = ["dashboard", "daily-test", "daily-test-result", "profile"] as const;

const dynamicCtaCardDefaults: Record<(typeof dynamicCtaCardScreens)[number], any> = {
  dashboard: {
    enabled: true,
    eyebrow: "NEET & JEE Unlock",
    title: "Go Premium",
    description: "Unlock unlimited questions, weak area analysis, and smart revision.",
    imageUrl: "",
    ctaText: "View Plans",
    ctaLink: "/subscription",
  },
  "daily-test": {
    enabled: true,
    eyebrow: "NEET & JEE Unlock",
    title: "Go Premium",
    description: "Unlock unlimited questions, weak area analysis, and smart revision.",
    imageUrl: "",
    ctaText: "View Plans",
    ctaLink: "/subscription",
  },
  "daily-test-result": {
    enabled: true,
    eyebrow: "Score Booster",
    title: "Improve Faster",
    description: "Upgrade for deeper result insights, weak area practice, and unlimited revision.",
    imageUrl: "",
    ctaText: "Upgrade Now",
    ctaLink: "/subscription",
  },
  profile: {
    enabled: true,
    eyebrow: "Unlock Your Potential",
    title: "Go Premium",
    description: "Access premium features, exclusive content, and smarter practice tools.",
    imageUrl: "",
    ctaText: "Buy Now",
    ctaLink: "/subscription",
  },
};

function sanitizeDynamicCtaCard(value: any = {}, screen: (typeof dynamicCtaCardScreens)[number]) {
  const defaults = dynamicCtaCardDefaults[screen];
  return {
    enabled: value.enabled !== false,
    eyebrow: String(value.eyebrow || defaults.eyebrow).trim().slice(0, 80),
    title: String(value.title || defaults.title).trim().slice(0, 120),
    description: String(value.description || defaults.description).trim().slice(0, 500),
    imageUrl: String(value.imageUrl || "").trim().slice(0, 500),
    ctaText: String(value.ctaText || defaults.ctaText).trim().slice(0, 80),
    ctaLink: String(value.ctaLink || defaults.ctaLink).trim().slice(0, 500),
  };
}

router.get("/dynamic-cta-cards", async (_req, res) => {
  const item = await WebsiteContent.findOne({ key: "dynamic-cta-cards", status: "published" }).lean();
  const legacy = await WebsiteContent.findOne({ key: "free-user-subscription-cta", status: "published" }).lean();
  const content = item?.content && typeof item.content === "object" ? item.content : {};
  const legacyContent = legacy?.content && typeof legacy.content === "object" ? legacy.content : {};
  const data = dynamicCtaCardScreens.reduce<Record<string, any>>((cards, screen) => {
    const source = screen === "dashboard" && !(content as any)[screen] ? legacyContent : (content as any)[screen];
    cards[screen] = sanitizeDynamicCtaCard(source, screen);
    return cards;
  }, {});
  res.json({ data });
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
