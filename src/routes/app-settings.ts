import { Router, type IRouter } from "express";
import { InvoiceSettings } from "@api/db";

const router: IRouter = Router();

async function getAppSettings() {
  const settings = await InvoiceSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, new: true },
  );

  return {
    appName: settings.companyName || "Krita NEET JEE",
    logoUrl: settings.logoUrl || "",
    updatedAt: settings.updatedAt,
  };
}

router.get("/", async (_req, res) => {
  res.json(await getAppSettings());
});

export default router;
