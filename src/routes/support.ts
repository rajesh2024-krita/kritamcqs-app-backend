import { Router, type IRouter } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { InvoiceSettings, SupportTicket, User, UserNotification } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { sendEmail } from "../lib/simple-email";

const router: IRouter = Router();
const uploadDir = path.resolve(process.cwd(), "uploads", "support");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
    if (!allowed.includes(file.mimetype)) {
      cb(new Error("Unsupported attachment type"));
      return;
    }
    cb(null, true);
  },
});

const CreateTicketBody = z.object({
  category: z.string().trim().min(2).max(80),
  message: z.string().trim().min(5).max(2000),
});

function buildTicketId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `SUP-${date}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function attachmentUrl(file?: Express.Multer.File) {
  return file ? `/uploads/support/${file.filename}` : "";
}

async function notifyAdmins(ticket: any) {
  const admins = await User.find({ isAdmin: true }).select("_id email").limit(50);
  if (admins.length) {
    await UserNotification.insertMany(
      admins.map((admin: any) => ({
        userId: String(admin._id),
        type: "support",
        title: "New support ticket",
        body: `${ticket.ticketId} - ${ticket.category}`,
        dedupeKey: `support-admin-${ticket.ticketId}-${String(admin._id)}`,
        linkUrl: "/admin/support",
      })),
      { ordered: false },
    ).catch(() => undefined);
  }

  const settings = await InvoiceSettings.findOne({ key: "default" });
  const to = settings?.companyEmail || settings?.smtp?.fromEmail || process.env["SUPPORT_EMAIL"] || "";
  if (!to || !settings?.smtp) return;

  await sendEmail({
    smtp: settings.smtp,
    to,
    subject: `New support ticket ${ticket.ticketId}`,
    text: `A learner submitted a support ticket.\n\nTicket: ${ticket.ticketId}\nCategory: ${ticket.category}\nName: ${ticket.userName || "-"}\nMobile: ${ticket.userMobile || "-"}\nEmail: ${ticket.userEmail || "-"}\n\nMessage:\n${ticket.messages?.[0]?.message || ""}`,
  }).catch(() => undefined);
}

router.get("/tickets", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const tickets = await SupportTicket.find({ userId: req.userId! }).sort({ updatedAt: -1 }).limit(50);
  res.json({ tickets });
});

router.post(
  "/tickets",
  requireAuth,
  requireOnboardingComplete,
  upload.single("attachment"),
  async (req: AuthenticatedRequest, res) => {
    try {
      const body = CreateTicketBody.parse(req.body);
      const user = req.user!;
      const ticket = await new SupportTicket({
        ticketId: buildTicketId(),
        userId: req.userId!,
        userName: user.name || "",
        userEmail: user.email || "",
        userMobile: user.mobile || "",
        category: body.category,
        status: "open",
        isReadByAdmin: false,
        messages: [
          {
            sender: "user",
            message: body.message,
            attachmentUrl: attachmentUrl(req.file),
            attachmentName: req.file?.originalname || "",
            createdAt: new Date(),
          },
        ],
      }).save();

      await notifyAdmins(ticket);
      res.status(201).json({ ticket });
    } catch (error) {
      req.log.error({ error }, "Create support ticket failed");
      res.status(400).json({ error: "support_ticket_failed", message: "Unable to submit support request" });
    }
  },
);

export default router;
