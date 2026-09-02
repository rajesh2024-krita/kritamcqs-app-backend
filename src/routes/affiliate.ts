import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { Affiliate, AffiliateAuditLog, AffiliateNotification, AffiliatePurchase, AffiliateReferral, AffiliateSettings, User } from "@api/db";
import { hashPassword, verifyPassword } from "../lib/password";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { affiliateMetrics, affiliateSettings, attachReferralToUser } from "../services/affiliateService";

const router = Router();
const secret = process.env["AFFILIATE_JWT_SECRET"] || process.env["SESSION_SECRET"];
if (!secret) throw new Error("AFFILIATE_JWT_SECRET or SESSION_SECRET is required");
const statuses = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;
type AffiliateRequest = Request & { affiliate?: any; affiliateId?: string };

function safeAffiliate(doc: any) { const value = doc?.toJSON ? doc.toJSON() : { ...doc }; delete value.passwordHash; delete value.accountNumber; return value; }
function platform(value: unknown) { const p = String(value || "WEB").toUpperCase(); return p === "ANDROID" || p === "IOS" ? p : "WEB"; }
function profileCompletion(data: any) { const keys = ["firstName", "lastName", "affiliateName", "email", "mobile", "profileImage", "address", "city", "state", "country", "pincode", "profession", "website", "description"]; return Math.round(keys.filter((key) => String(data[key] || "").trim()).length / keys.length * 100); }
function pageValues(query: any) { const page = Math.max(1, Number(query.page || 1)); const limit = Math.min(500, Math.max(1, Number(query.limit || 50))); return { page, limit, skip: (page - 1) * limit }; }
function queryDate(value: unknown) { const date = new Date(String(value || "")); return Number.isNaN(date.getTime()) ? null : date; }
function withDateRange(filter: any, query: any, field = "clickAt") { const from = queryDate(query.from || query.startDate); const to = queryDate(query.to || query.endDate); if (from || to) filter[field] = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) }; }
function referralFilters(query: any, base: any = {}) {
  const filter: any = { ...base };
  withDateRange(filter, query);
  if (query.affiliateId) filter.affiliateId = query.affiliateId;
  if (query.affiliateCode) filter.affiliateCode = String(query.affiliateCode).toUpperCase();
  if (query.campaign) filter.campaign = String(query.campaign);
  if (query.affiliateLinkId) filter.affiliateLinkId = String(query.affiliateLinkId);
  for (const key of ["clickStatus", "installationStatus", "registrationStatus", "loginStatus", "purchaseStatus", "conversionStatus", "userType", "attributionStatus"]) if (query[key]) filter[key] = String(query[key]).toUpperCase();
  if (query.platform) filter.platform = platform(query.platform);
  return filter;
}
function purchaseFilters(query: any, base: any = {}) {
  const filter: any = { ...base };
  withDateRange(filter, query, "purchaseAt");
  if (query.affiliateId) filter.affiliateId = query.affiliateId;
  if (query.platform) filter.platform = platform(query.platform);
  if (query.paymentStatus) filter.paymentStatus = String(query.paymentStatus).toUpperCase();
  if (query.purchaseStatus) filter.paymentStatus = String(query.purchaseStatus).toUpperCase();
  if (query.conversionStatus) filter.conversionStatus = String(query.conversionStatus).toUpperCase();
  return filter;
}
async function affiliateAuth(req: AffiliateRequest, res: Response, next: NextFunction) {
  try { const token = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) throw new Error(); const payload = jwt.verify(token, secret) as any; if (payload.role !== "affiliate") throw new Error(); const affiliate = await Affiliate.findById(payload.affiliateId); if (!affiliate || affiliate.status !== "ACTIVE") { res.status(403).json({ message: "Affiliate account is not active" }); return; } req.affiliate = affiliate; req.affiliateId = String(affiliate._id); next(); } catch { res.status(401).json({ message: "Invalid or expired affiliate session" }); }
}

router.post("/track", async (req, res) => {
  const code = String(req.body?.affiliateCode || req.query["ref"] || "").trim().toUpperCase();
  const affiliate = await Affiliate.findOne({ affiliateCode: code, status: "ACTIVE" });
  if (!affiliate) { res.status(404).json({ message: "Affiliate referral is invalid or inactive" }); return; }
  const settings = await affiliateSettings();
  const referralClickId = crypto.randomUUID();
  const clickAt = new Date();
  const expiresAt = new Date(clickAt.getTime() + Number(settings.attributionWindowDays || 30) * 86400000);
  const referral = await AffiliateReferral.create({ affiliateId: affiliate._id, affiliateCode: code, referralClickId, campaign: String(req.body?.campaign || req.query["campaign"] || "").slice(0, 120), affiliateLinkId: String(req.body?.affiliateLinkId || req.query["link"] || "").slice(0, 120), referralUrl: String(req.body?.referralUrl || "").slice(0, 1000), platform: platform(req.body?.platform), deviceType: String(req.body?.deviceType || "").slice(0, 200), browser: String(req.body?.browser || "").slice(0, 200), osName: String(req.body?.osName || "").slice(0, 100), osVersion: String(req.body?.osVersion || "").slice(0, 50), appVersion: String(req.body?.appVersion || "").slice(0, 50), ipAddress: String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(), userAgent: String(req.headers["user-agent"] || "").slice(0, 500), clickAt, expiresAt });
  res.status(201).json({ referralClickId, affiliateCode: code, expiresInDays: settings.attributionWindowDays, expiresAt, id: String(referral._id) });
});
router.post("/attribution", requireAuth, async (req: AuthenticatedRequest, res) => { const mode = String(req.body?.eventType || "").toLowerCase() === "registration" ? "registration" : "login"; const referral = await attachReferralToUser(String(req.body?.referralClickId || ""), String(req.userId), new Date(), mode); res.json({ attributed: Boolean(referral), referralId: referral?._id ? String(referral._id) : null }); });
router.post("/first-open", async (req, res) => { const referralClickId = String(req.body?.referralClickId || ""); if (!referralClickId) { res.status(400).json({ message: "referralClickId is required" }); return; } const rawInstallStatus = String(req.body?.installationStatus || "").toUpperCase(); const installStatus = rawInstallStatus === "EXISTING_APP_USER" || req.body?.alreadyInstalled === true ? "EXISTING_APP_USER" : "NEW_INSTALL"; const referral = await AffiliateReferral.findOneAndUpdate({ referralClickId }, { $set: { firstAppOpenAt: new Date(), installationStatus: installStatus, appVersion: String(req.body?.appVersion || "").slice(0, 50), platform: platform(req.body?.platform) } }, { new: true }); res.json({ recorded: Boolean(referral) }); });

router.post("/auth/login", async (req, res) => { const identifier = String(req.body?.identifier || "").trim().toLowerCase(); const affiliate = await Affiliate.findOne({ $or: [{ email: identifier }, { username: identifier }] }).select("+passwordHash"); if (!affiliate || !verifyPassword(String(req.body?.password || ""), affiliate.passwordHash)) { res.status(401).json({ message: "Invalid username/email or password" }); return; } if (affiliate.status !== "ACTIVE") { res.status(403).json({ message: "Affiliate account is not active" }); return; } affiliate.lastLoginAt = new Date(); await affiliate.save(); const token = jwt.sign({ affiliateId: String(affiliate._id), role: "affiliate" }, secret, { expiresIn: req.body?.rememberMe ? "30d" : "12h" }); res.json({ token, affiliate: safeAffiliate(affiliate) }); });
router.get("/me", affiliateAuth, (req: AffiliateRequest, res) => res.json({ affiliate: safeAffiliate(req.affiliate) }));
router.get("/dashboard", affiliateAuth, async (req: AffiliateRequest, res) => res.json(await affiliateMetrics(referralFilters(req.query, { affiliateId: req.affiliate!._id }))));
router.get("/referrals", affiliateAuth, async (req: AffiliateRequest, res) => { const { page, limit, skip } = pageValues(req.query); const filter = referralFilters(req.query, { affiliateId: req.affiliate!._id }); const [items, total] = await Promise.all([AffiliateReferral.find(filter).sort({ clickAt: -1 }).skip(skip).limit(limit).lean(), AffiliateReferral.countDocuments(filter)]); const users = await User.find({ _id: { $in: items.map((x: any) => x.userId).filter(Boolean) } }).select("name email mobile").lean(); const map = new Map(users.map((u: any) => [String(u._id), u])); res.json({ items: items.map((x: any) => ({ ...x, user: map.get(String(x.userId)) })), total, page, limit }); });
router.get("/purchases", affiliateAuth, async (req: AffiliateRequest, res) => { const { page, limit, skip } = pageValues(req.query); const filter = purchaseFilters(req.query, { affiliateId: req.affiliate!._id, paymentStatus: "PAID", subscriptionStatus: { $ne: "REFUNDED" } }); const [items, total] = await Promise.all([AffiliatePurchase.find(filter).sort({ purchaseAt: -1 }).skip(skip).limit(limit).lean(), AffiliatePurchase.countDocuments(filter)]); res.json({ items, total, page, limit }); });
router.get("/notifications", affiliateAuth, async (req: AffiliateRequest, res) => res.json(await AffiliateNotification.find({ affiliateId: req.affiliate!._id }).sort({ createdAt: -1 }).limit(100)));
router.patch("/profile", affiliateAuth, async (req: AffiliateRequest, res) => { const allowed = ["firstName", "lastName", "affiliateName", "email", "mobile", "profileImage", "address", "city", "state", "country", "pincode", "company", "organization", "profession", "website", "socialMediaLinks", "description", "accountHolderName", "bankName", "accountNumber", "ifsc", "upiId", "pan", "gst"]; const update: any = {}; for (const key of allowed) if (req.body?.[key] !== undefined) update[key] = req.body[key]; update.profileCompletion = profileCompletion({ ...req.affiliate!.toObject(), ...update }); const affiliate = await Affiliate.findByIdAndUpdate(req.affiliateId, { $set: update }, { new: true, runValidators: true }); res.json({ affiliate: safeAffiliate(affiliate) }); });
router.post("/change-password", affiliateAuth, async (req: AffiliateRequest, res) => { const newPassword = String(req.body?.newPassword || ""); if (newPassword.length < 8) { res.status(400).json({ message: "New password must be at least 8 characters" }); return; } const affiliate = await Affiliate.findById(req.affiliateId).select("+passwordHash"); if (!affiliate || !verifyPassword(String(req.body?.currentPassword || ""), affiliate.passwordHash)) { res.status(403).json({ message: "Current password is incorrect" }); return; } affiliate.passwordHash = hashPassword(newPassword); await affiliate.save(); res.json({ message: "Password changed" }); });

router.get("/admin/affiliates", requireAdmin, async (_req, res) => { const affiliates = await Affiliate.find().sort({ createdAt: -1 }).lean(); const metrics = await Promise.all(affiliates.map((affiliate: any) => affiliateMetrics({ affiliateId: affiliate._id }))); res.json(affiliates.map((affiliate: any, index) => ({ ...affiliate, id: String(affiliate._id), ...metrics[index] }))); });
router.post("/admin/affiliates", requireAdmin, async (req: AuthenticatedRequest, res) => { const parsed = z.object({ firstName: z.string().min(1), lastName: z.string().optional(), affiliateName: z.string().min(1), email: z.string().email(), mobile: z.string().optional(), username: z.string().min(4), password: z.string().min(8), affiliateCode: z.string().regex(/^[A-Za-z0-9_-]{4,24}$/).optional(), status: z.enum(statuses).default("ACTIVE") }).parse(req.body); let code = parsed.affiliateCode?.toUpperCase(); if (!code) { const count = await Affiliate.countDocuments(); code = `AFF${String(count + 1).padStart(4, "0")}`; while (await Affiliate.exists({ affiliateCode: code })) code = `AFF${crypto.randomInt(1000, 999999)}`; } const settings = await affiliateSettings(); const affiliate = await Affiliate.create({ ...req.body, ...parsed, affiliateCode: code, passwordHash: hashPassword(parsed.password), referralLink: `${String(settings.referralBaseUrl).replace(/\/$/, "")}/?ref=${code}`, profileCompletion: profileCompletion(req.body) }); await AffiliateAuditLog.create({ adminId: req.userId, affiliateId: affiliate._id, action: "Affiliate Created", newData: safeAffiliate(affiliate) }); await AffiliateNotification.create({ affiliateId: affiliate._id, notificationType: "ACCOUNT_CREATED", title: "Affiliate account created", message: "Your Krita MCQs affiliate account has been created." }); res.status(201).json({ affiliate: safeAffiliate(affiliate) }); });
router.patch("/admin/affiliates/:id", requireAdmin, async (req: AuthenticatedRequest, res) => { const old = await Affiliate.findById(req.params["id"]); if (!old) { res.status(404).json({ message: "Affiliate not found" }); return; } const blocked = ["passwordHash", "affiliateCode", "referralLink", "_id"]; const update: any = {}; for (const [key, value] of Object.entries(req.body || {})) if (!blocked.includes(key)) update[key] = value; update.profileCompletion = profileCompletion({ ...old.toObject(), ...update }); const affiliate = await Affiliate.findByIdAndUpdate(old._id, { $set: update }, { new: true, runValidators: true }); await AffiliateAuditLog.create({ adminId: req.userId, affiliateId: old._id, action: update.status ? `Affiliate ${update.status}` : "Affiliate Updated", oldData: safeAffiliate(old), newData: safeAffiliate(affiliate) }); res.json({ affiliate: safeAffiliate(affiliate) }); });
router.post("/admin/affiliates/:id/reset-password", requireAdmin, async (req: AuthenticatedRequest, res) => { const password = String(req.body?.password || ""); if (password.length < 8) { res.status(400).json({ message: "Password must be at least 8 characters" }); return; } await Affiliate.findByIdAndUpdate(req.params["id"], { passwordHash: hashPassword(password) }); await AffiliateAuditLog.create({ adminId: req.userId, affiliateId: req.params["id"], action: "Password Reset" }); res.json({ message: "Password reset" }); });
router.get("/admin/dashboard", requireAdmin, async (req, res) => { const [totalAffiliates, activeAffiliates, metrics] = await Promise.all([Affiliate.countDocuments(), Affiliate.countDocuments({ status: "ACTIVE" }), affiliateMetrics(referralFilters(req.query))]); res.json({ totalAffiliates, activeAffiliates, ...metrics }); });
router.get("/admin/referrals", requireAdmin, async (req, res) => { const { page, limit, skip } = pageValues(req.query); const filter = referralFilters(req.query); const [items, total] = await Promise.all([AffiliateReferral.find(filter).populate("affiliateId", "affiliateName affiliateCode").sort({ clickAt: -1 }).skip(skip).limit(limit).lean(), AffiliateReferral.countDocuments(filter)]); res.json({ items, total, page, limit }); });
router.get("/admin/purchases", requireAdmin, async (req, res) => { const { page, limit, skip } = pageValues(req.query); const filter = purchaseFilters(req.query); const [items, total] = await Promise.all([AffiliatePurchase.find(filter).populate("affiliateId", "affiliateName affiliateCode").sort({ purchaseAt: -1 }).skip(skip).limit(limit).lean(), AffiliatePurchase.countDocuments(filter)]); res.json({ items, total, page, limit }); });
router.get("/admin/settings", requireAdmin, async (_req, res) => res.json(await affiliateSettings()));
router.patch("/admin/settings", requireAdmin, async (req: AuthenticatedRequest, res) => { const old = await affiliateSettings(); const settings = await AffiliateSettings.findOneAndUpdate({ key: "default" }, { $set: req.body }, { new: true, runValidators: true }); await AffiliateAuditLog.create({ adminId: req.userId, action: "Notification Settings Changed", oldData: old, newData: settings }); res.json(settings); });
router.get("/admin/audit-logs", requireAdmin, async (_req, res) => res.json(await AffiliateAuditLog.find().sort({ createdAt: -1 }).limit(500)));

export default router;
