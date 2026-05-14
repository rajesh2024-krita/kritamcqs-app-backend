import { Router, type IRouter } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { z } from "zod";
import { HelpDeskSettings, InvoiceSettings, SupportTicket, User, UserNotification } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { EMAIL_TEMPLATE_KEYS, sendTemplatedEmail } from "../lib/email-templates";

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

async function emailAttachment(file?: Express.Multer.File) {
  if (!file) return [];
  return [{
    filename: file.originalname || "attachment",
    contentType: file.mimetype,
    content: await fsp.readFile(file.path),
  }];
}

async function notifyAdmins(ticket: any, file?: Express.Multer.File) {
  const helpSettings = await HelpDeskSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const shouldSaveDatabase = helpSettings.mode === "database" || helpSettings.mode === "both";
  const shouldSendEmail = helpSettings.mode === "email" || helpSettings.mode === "both";
  const admins = await User.find({ isAdmin: true }).select("_id email").limit(50);
  if (shouldSaveDatabase && admins.length) {
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
  const adminTo = helpSettings.adminEmail || settings?.companyEmail || settings?.smtp?.fromEmail || process.env["SUPPORT_EMAIL"] || "";
  const variables = {
    user_name: ticket.userName || "Learner",
    email: ticket.userEmail || "",
    mobile: ticket.userMobile || "",
    ticket_id: ticket.ticketId,
    ticket_category: ticket.category,
    ticket_subject: ticket.category,
    ticket_status: ticket.status || "open",
    ticket_message: ticket.messages?.[0]?.message || "",
    reply_message: ticket.messages?.[0]?.message || "",
    attachment_name: file?.originalname || "",
    admin_email: adminTo,
    support_email: settings?.companyEmail || settings?.smtp?.fromEmail || "support@krita.com",
  };
  const attachments = await emailAttachment(file);
  if (shouldSendEmail && adminTo) {
    await sendTemplatedEmail(helpSettings.ticketReceivedTemplateKey || EMAIL_TEMPLATE_KEYS.HELPDESK_TICKET_CREATED, adminTo, variables, attachments).catch(() => undefined);
  }
  if (shouldSendEmail && ticket.userEmail) {
    await sendTemplatedEmail(helpSettings.autoReplyTemplateKey || EMAIL_TEMPLATE_KEYS.HELPDESK_AUTO_REPLY, ticket.userEmail, variables).catch(() => undefined);
  }
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
      const helpSettings = await HelpDeskSettings.findOneAndUpdate(
        { key: "default" },
        { $setOnInsert: { key: "default" } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      const ticketPayload = {
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
      };
      const ticket = helpSettings.mode === "email"
        ? ticketPayload
        : await new SupportTicket(ticketPayload).save();

      await notifyAdmins(ticket, req.file);
      res.status(201).json({ ticket });
    } catch (error) {
      req.log.error({ error }, "Create support ticket failed");
      res.status(400).json({ error: "support_ticket_failed", message: "Unable to submit support request" });
    }
  },
);

export default router;
