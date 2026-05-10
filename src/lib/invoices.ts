import fs from "node:fs/promises";
import path from "node:path";
import {
  Invoice,
  InvoiceSettings,
  NotificationSettings,
  Subscription,
  SubscriptionPlan,
  User,
  UserNotification,
} from "@api/db";
import { sendEmail } from "./simple-email";
import { logger } from "./logger";

const defaultFields = [
  { id: "invoiceNumber", label: "Invoice # {{invoiceNumber}}", x: 48, y: 118, size: 10, enabled: true },
  { id: "issuedAt", label: "Issued: {{invoiceDate}}", x: 48, y: 134, size: 10, enabled: true },
  { id: "customer", label: "Bill To: {{userName}}", x: 48, y: 166, size: 11, enabled: true },
  { id: "email", label: "Email: {{userEmail}}", x: 48, y: 182, size: 10, enabled: true },
  { id: "mobile", label: "Mobile: {{userMobile}}", x: 48, y: 198, size: 10, enabled: true },
  { id: "transaction", label: "Transaction ID: {{transactionId}}", x: 48, y: 214, size: 10, enabled: true },
  { id: "paidStamp", label: "{{paidStampText}}", x: 430, y: 120, size: 30, enabled: true },
];

const defaultReminders = [10, 5, 2, 0].map((daysBefore) => ({
  daysBefore,
  enabled: true,
  title: daysBefore === 0 ? "Premium expires today" : `Premium expires in ${daysBefore} days`,
  body:
    daysBefore === 0
      ? "Your premium plan expires today. Renew to keep unlimited access."
      : `Your premium plan expires in ${daysBefore} days. Renew to keep unlimited access.`,
  emailSubject: daysBefore === 0 ? "Your Krita Premium expires today" : `Your Krita Premium expires in ${daysBefore} days`,
  emailBody:
    daysBefore === 0
      ? "Hi {{userName}}, your premium plan expires today. Renew to continue uninterrupted access."
      : "Hi {{userName}}, your premium plan expires in {{daysBefore}} days. Renew to continue uninterrupted access.",
}));

export async function getInvoiceSettings() {
  return InvoiceSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default", fields: defaultFields } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function getNotificationSettings() {
  return NotificationSettings.findOneAndUpdate(
    { key: "subscription-expiry" },
    { $setOnInsert: { key: "subscription-expiry", reminders: defaultReminders } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function esc(value: unknown) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function replaceTokens(template: string, data: Record<string, unknown>) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_match, key) => String(data[key] ?? ""));
}

function textOp(text: string, x: number, y: number, size = 10) {
  return `BT /F1 ${size} Tf ${x} ${842 - y} Td (${esc(text)}) Tj ET`;
}

function buildPdf(lines: string[]) {
  const objects: string[] = [];
  const add = (value: string) => {
    objects.push(value);
    return objects.length;
  };
  const content = lines.join("\n");
  const contentId = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageId = add(`<< /Type /Page /Parent 4 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
  const pagesId = add(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join("")));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xref = Buffer.byteLength(chunks.join(""));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`));
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return Buffer.from(chunks.join(""), "utf8");
}

async function saveInvoicePdf(buffer: Buffer, invoiceNumber: string) {
  const dir = path.resolve(process.cwd(), "uploads", "invoices");
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${invoiceNumber.replace(/[^a-z0-9_-]/gi, "-")}.pdf`;
  const fullPath = path.join(dir, fileName);
  await fs.writeFile(fullPath, buffer);
  return `/uploads/invoices/${fileName}`;
}

function invoiceData(input: any) {
  const firstItem = Array.isArray(input.items) ? input.items[0] || {} : {};
  const formatCurrency = (value: unknown) => `${input.currency || "Rs."} ${Number(value || 0).toFixed(2)}`;
  return {
    invoiceNumber: input.invoiceNumber,
    issuedAt: new Date(input.issuedAt || input.invoiceDate).toLocaleDateString("en-IN"),
    invoiceDate: new Date(input.invoiceDate || input.issuedAt).toLocaleDateString("en-IN"),
    dueDate: input.dueDate ? new Date(input.dueDate).toLocaleDateString("en-IN") : "",
    userName: input.userName || "Learner",
    userEmail: input.userEmail || "",
    userMobile: input.userMobile || "",
    customerAddress: input.customerCompany?.address || "",
    customerGstin: input.customerCompany?.gstin || "",
    planName: input.planName || input.planId,
    productDescription: firstItem.description || "Premium subscription purchase",
    quantity: firstItem.quantity || 1,
    baseAmount: formatCurrency(input.subtotal ?? firstItem.price ?? input.amount),
    discountAmount: formatCurrency(input.discountTotal || 0),
    taxAmount: formatCurrency(input.taxTotal || 0),
    amount: formatCurrency(input.amount || input.grandTotal),
    totalAmount: formatCurrency(input.grandTotal || input.amount),
    currency: input.currency || "INR",
    paymentStatus: String(input.status || "paid").toUpperCase(),
    transactionId: input.transactionId || "",
    paidStampText: input.paidStampText || "PAID",
  };
}

export async function generateInvoiceForSubscription(subscriptionId: string) {
  const existing = await Invoice.findOne({ subscriptionId });
  if (existing) return existing;

  const [subscription, settings] = await Promise.all([Subscription.findById(subscriptionId), getInvoiceSettings()]);
  if (!subscription || subscription.status !== "active") throw new Error("Active subscription not found for invoice");

  const [user, plan] = await Promise.all([
    User.findById(subscription.userId),
    SubscriptionPlan.findOne({ planId: subscription.planId }),
  ]);

  const invoiceNumber = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(Date.now()).slice(-6)}`;
  const invoice = await Invoice.create({
    invoiceNumber,
    userId: subscription.userId,
    subscriptionId,
    planId: subscription.planId,
    userName: user?.name || user?.mobile || "Learner",
    userEmail: user?.email || "",
    userMobile: user?.mobile || "",
    customerCompany: {
      name: user?.name || user?.mobile || "Learner",
      email: user?.email || "",
      phone: user?.mobile || "",
      address: user?.address || "",
    },
    amount: Number(subscription.amount || 0),
    subtotal: Number(subscription.baseAmount || subscription.amount || 0),
    discountTotal: Number(subscription.discountAmount || 0),
    grandTotal: Number(subscription.amount || 0),
    currency: "INR",
    status: "paid",
    transactionId: subscription.razorpayPaymentId || subscription.razorpayOrderId || "",
    invoiceDate: new Date(),
    dueDate: subscription.endDate,
    items: [{
      product: plan?.name || subscription.planId,
      description: "Premium subscription purchase",
      quantity: 1,
      price: Number(subscription.baseAmount || subscription.amount || 0),
      discount: Number(subscription.discountAmount || 0),
      tax: 0,
      total: Number(subscription.amount || 0),
    }],
    emailStatus: "pending",
    issuedAt: new Date(),
    activityLogs: [{ action: "created", message: "Invoice generated from purchase", at: new Date() }],
  });

  const data = invoiceData({ ...invoice.toJSON(), userMobile: user?.mobile || "", planName: plan?.name, paidStampText: settings.paidStampText });
  const content = [
    textOp(settings.companyName, 48, 48, 20),
    textOp(settings.companyAddress || "", 48, 70, 9),
    textOp(settings.companyEmail || "", 48, 84, 9),
    textOp(settings.templateTitle, 360, 52, 22),
    textOp(settings.templateIntro, 48, 220, 10),
    textOp(settings.productDetailsTitle, 48, 280, 13),
    textOp(`Plan: ${data.planName}`, 48, 304, 10),
    textOp(`Amount: ${data.totalAmount}`, 48, 322, 10),
    textOp(`Discount: ${data.discountAmount}`, 48, 340, 10),
    textOp(`Status: ${data.paymentStatus}`, 48, 358, 10),
    textOp(`Transaction ID: ${data.transactionId || "-"}`, 48, 376, 10),
    ...(settings.fields || defaultFields)
      .filter((field: any) => field.enabled !== false && field.type !== "image")
      .map((field: any) => textOp(replaceTokens(field.label, data), Number(field.x || 48), Number(field.y || 120), Number(field.size || 10))),
    textOp(settings.footerText, 48, 785, 9),
  ];
  const pdf = buildPdf(content);
  invoice.pdfPath = await saveInvoicePdf(pdf, invoice.invoiceNumber);
  await invoice.save();

  if (settings.enabled && settings.emailEnabled && invoice.userEmail) {
    try {
      const result = await sendEmail({
        smtp: settings.smtp || {},
        to: invoice.userEmail,
        subject: `Invoice ${invoice.invoiceNumber} from ${settings.companyName}`,
        text: `Hi ${invoice.userName || "Learner"},\n\nYour purchase invoice is attached.\n\nInvoice: ${invoice.invoiceNumber}\nProduct: ${data.planName}\nAmount: ${data.totalAmount}\nPayment Status: ${data.paymentStatus}\nTransaction ID: ${data.transactionId || "-"}\n\n${settings.companyName}`,
        attachments: [{ filename: `${invoice.invoiceNumber}.pdf`, contentType: "application/pdf", content: pdf }],
      });
      invoice.emailStatus = result.skipped ? "skipped" : "sent";
      invoice.emailError = result.skipped ? result.reason : "";
      invoice.sentAt = result.skipped ? undefined : new Date();
      await invoice.save();
    } catch (error) {
      invoice.emailStatus = "failed";
      invoice.emailError = error instanceof Error ? error.message : "Email failed";
      await invoice.save();
    }
  } else {
    invoice.emailStatus = "skipped";
    invoice.emailError = invoice.userEmail ? "Invoice email disabled" : "User email missing";
    await invoice.save();
  }

  return invoice;
}

export async function processExpiryReminders() {
  const settings = await getNotificationSettings();
  if (!settings.enabled) return { created: 0 };

  let created = 0;
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  for (const reminder of settings.reminders.filter((item: any) => item.enabled !== false)) {
    const target = new Date(dayStart);
    target.setDate(target.getDate() + Number(reminder.daysBefore || 0));
    const next = new Date(target);
    next.setDate(next.getDate() + 1);

    const subscriptions = await Subscription.find({ status: "active", endDate: { $gte: target, $lt: next } });
    for (const subscription of subscriptions) {
      const user = await User.findById(subscription.userId);
      if (!user) continue;
      const data = {
        userName: user.name || user.mobile || "Learner",
        daysBefore: reminder.daysBefore,
        expiryDate: subscription.endDate ? new Date(subscription.endDate).toLocaleDateString("en-IN") : "",
      };
      const dedupeKey = `subscription-expiry:${subscription.id}:${reminder.daysBefore}`;
      const notification = await UserNotification.findOneAndUpdate(
        { dedupeKey },
        {
          userId: subscription.userId,
          type: "subscription",
          title: replaceTokens(reminder.title, data),
          body: replaceTokens(reminder.body, data),
          dedupeKey,
          visibleInApp: settings.inAppEnabled !== false,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      if (notification.createdAt?.getTime() === notification.updatedAt?.getTime()) created += 1;

      if (settings.emailEnabled && user.email && !notification.emailStatus) {
        const invoiceSettings = await getInvoiceSettings();
        try {
          const result = await sendEmail({
            smtp: invoiceSettings.smtp || {},
            to: user.email,
            subject: replaceTokens(reminder.emailSubject, data),
            text: replaceTokens(reminder.emailBody, data),
          });
          notification.emailStatus = result.skipped ? "skipped" : "sent";
          await notification.save();
        } catch (error) {
          notification.emailStatus = "failed";
          await notification.save();
          logger.warn({ err: error }, "Expiry reminder email failed");
        }
      }
    }
  }

  return { created };
}

let reminderTimer: NodeJS.Timeout | null = null;
export function startExpiryReminderWorker() {
  if (reminderTimer) return;
  const run = () => processExpiryReminders().catch((err) => logger.warn({ err }, "Expiry reminder worker failed"));
  reminderTimer = setInterval(run, 1000 * 60 * 60 * 6);
  run();
}
