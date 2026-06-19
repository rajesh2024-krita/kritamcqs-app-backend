import { Router, type IRouter } from "express";
import { CmsMenuItem, CmsPage, PolicyPage, WebsiteContent, WebsiteSettings } from "@api/db";

const router: IRouter = Router();

router.get("/", async (_req, res) => {
  const item = await WebsiteContent.findOne({ key: "landing", status: "published" })
    .sort({ publishedAt: -1, updatedAt: -1 })
    .lean();
  res.json({ success: true, data: item?.content || {} });
});

router.get("/settings", async (_req, res) => {
  const settings = await WebsiteSettings.findOne({ key: "default", active: { $ne: false } }).lean();
  res.json({ success: true, data: settings || null });
});

router.get("/menus", async (_req, res) => {
  const items = await CmsMenuItem.find({ active: true, visible: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  res.json({ success: true, data: items.map((item: any) => ({ ...item, id: String(item._id), _id: undefined })) });
});

router.get("/pages", async (_req, res) => {
  const pages = await CmsPage.find({ active: true, status: "published", deletedAt: { $exists: false } }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  res.json({ success: true, data: pages.map((page: any) => ({ ...page, id: String(page._id), _id: undefined })) });
});

router.get("/pages/:slug", async (req, res) => {
  const slug = String(req.params["slug"] || "").replace(/^\/+|\/+$/g, "");
  const page = await CmsPage.findOne({ slug, active: true, status: "published", deletedAt: { $exists: false } }).lean();
  res.json({ success: true, data: page ? { ...page, id: String(page._id), _id: undefined } : null });
});

router.get("/policies", async (_req, res) => {
  const policies = await PolicyPage.find({ active: true, status: "published" }).sort({ sortOrder: 1, createdAt: 1 }).lean();
  res.json({ success: true, data: policies.map((policy: any) => ({ ...policy, id: String(policy._id), _id: undefined })) });
});

router.get("/policies/:slug", async (req, res) => {
  const slug = String(req.params["slug"] || "").replace(/^\/+|\/+$/g, "");
  const policy = await PolicyPage.findOne({ slug, active: true, status: "published" }).lean();
  res.json({ success: true, data: policy ? { ...policy, id: String(policy._id), _id: undefined } : null });
});

export default router;
