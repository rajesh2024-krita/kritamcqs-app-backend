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

function textStyleOp(raw: any = {}) {
  const bold = String(raw.fontWeight || "").toLowerCase() === "bold" || Number(raw.fontWeight || 0) >= 600;
  const italic = String(raw.fontStyle || "").toLowerCase() === "italic";
  if (bold && italic) return "/F4";
  if (bold) return "/F2";
  if (italic) return "/F3";
  return "/F1";
}

function hexToRgb(value: unknown, fallback = [0, 0, 0]) {
  const hex = String(value || "").trim();
  const match = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const raw = match[1];
  return [parseInt(raw.slice(0, 2), 16) / 255, parseInt(raw.slice(2, 4), 16) / 255, parseInt(raw.slice(4, 6), 16) / 255];
}

function colorOp(fill = "#000000", stroke: unknown = fill) {
  const [fr, fg, fb] = hexToRgb(fill);
  const [sr, sg, sb] = hexToRgb(stroke, [fr, fg, fb]);
  return `${fr.toFixed(3)} ${fg.toFixed(3)} ${fb.toFixed(3)} rg ${sr.toFixed(3)} ${sg.toFixed(3)} ${sb.toFixed(3)} RG`;
}

function coloredTextOp(text: string, x: number, y: number, size = 10, color = "#000000") {
  return `${colorOp(color)} ${textOp(text, x, y, size)} 0 0 0 rg 0 0 0 RG`;
}

function angleMatrix(degrees: number, x = 0, y = 0) {
  const radians = (Number(degrees || 0) * Math.PI) / 180;
  const cos = Math.cos(radians).toFixed(6);
  const sin = Math.sin(radians).toFixed(6);
  return `${cos} ${sin} ${(-Math.sin(radians)).toFixed(6)} ${cos} ${x} ${y}`;
}

function styledTextOp(text: string, x: number, y: number, size = 10, color = "#000000", raw: any = {}) {
  const angle = Number(raw.angle || 0);
  const font = textStyleOp(raw);
  const drawText = angle
    ? `BT ${font} ${size} Tf ${angleMatrix(angle, x, 842 - y)} Tm (${esc(text)}) Tj ET`
    : `BT ${font} ${size} Tf ${x} ${842 - y} Td (${esc(text)}) Tj ET`;
  return `${colorOp(color)} ${drawText} 0 0 0 rg 0 0 0 RG`;
}

function lineOp(x1: number, y1: number, x2: number, y2: number) {
  return `${x1} ${842 - y1} m ${x2} ${842 - y2} l S`;
}

function rectOp(x: number, y: number, width: number, height: number) {
  return `${x} ${842 - y - height} ${width} ${height} re S`;
}

function fillRectOp(x: number, y: number, width: number, height: number, shade = 0.94) {
  return `${shade} g ${x} ${842 - y - height} ${width} ${height} re f 0 g`;
}

function colorRectOp(x: number, y: number, width: number, height: number, fill = "#ffffff", stroke = "#000000", strokeWidth = 0) {
  const draw = Number(strokeWidth || 0) > 0 ? "B" : "f";
  return `${colorOp(fill, stroke)} ${Number(strokeWidth || 0)} w ${x} ${842 - y - height} ${width} ${height} re ${draw} 0 0 0 rg 0 0 0 RG 1 w`;
}

function rotateOp(inner: string, x: number, y: number, angle = 0) {
  if (!Number(angle)) return inner;
  const radians = (Number(angle) * Math.PI) / 180;
  const cos = Math.cos(radians).toFixed(6);
  const sin = Math.sin(radians).toFixed(6);
  const px = Number(x || 0);
  const py = 842 - Number(y || 0);
  return `q 1 0 0 1 ${px} ${py} cm ${cos} ${sin} ${(-Math.sin(radians)).toFixed(6)} ${cos} 0 0 cm 1 0 0 1 ${-px} ${-py} cm ${inner} Q`;
}

function rotateCenterOp(inner: string, x: number, y: number, width: number, height: number, angle = 0) {
  return rotateOp(inner, x + width / 2, y + height / 2, angle);
}

function colorCircleOp(x: number, y: number, radius: number, fill = "#ffffff", stroke = "#000000", strokeWidth = 0) {
  const c = 0.5522847498;
  const cx = x + radius;
  const cy = 842 - (y + radius);
  const r = radius;
  const draw = Number(strokeWidth || 0) > 0 ? "B" : "f";
  return `${colorOp(fill, stroke)} ${Number(strokeWidth || 0)} w ${cx + r} ${cy} m ${cx + r} ${cy + c * r} ${cx + c * r} ${cy + r} ${cx} ${cy + r} c ${cx - c * r} ${cy + r} ${cx - r} ${cy + c * r} ${cx - r} ${cy} c ${cx - r} ${cy - c * r} ${cx - c * r} ${cy - r} ${cx} ${cy - r} c ${cx + c * r} ${cy - r} ${cx + r} ${cy - c * r} ${cx + r} ${cy} c ${draw} 0 0 0 rg 0 0 0 RG 1 w`;
}

function colorTriangleOp(x: number, y: number, width: number, height: number, fill = "#ffffff", stroke = "#000000", strokeWidth = 0) {
  const draw = Number(strokeWidth || 0) > 0 ? "B" : "f";
  return `${colorOp(fill, stroke)} ${Number(strokeWidth || 0)} w ${x + width / 2} ${842 - y} m ${x + width} ${842 - y - height} l ${x} ${842 - y - height} l h ${draw} 0 0 0 rg 0 0 0 RG 1 w`;
}

function textLines(text: unknown, x: number, y: number, size = 10, lineHeight = 14) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => textOp(line, x, y + index * lineHeight, size));
}

function pageMetricsFromFields(fields: any[]) {
  const first = fields.find((field) => field?.raw?.pageWidth && field?.raw?.pageHeight);
  const pageWidth = Number(first?.raw?.pageWidth || 794);
  const pageHeight = Number(first?.raw?.pageHeight || 1123);
  return {
    scaleX: 595 / pageWidth,
    scaleY: 842 / pageHeight,
    pageLeft: 0,
    pageTop: 0,
  };
}

function imageSizeFromJpeg(buffer: Buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function imageFromDataUrl(src: unknown, width: number, height: number) {
  const match = String(src || "").match(/^data:image\/jpe?g;base64,(.+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[1], "base64");
  const size = imageSizeFromJpeg(buffer) || { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  return { buffer, width: size.width, height: size.height };
}

function imageOp(name: string, x: number, y: number, width: number, height: number) {
  return `q ${width} 0 0 ${height} ${x} ${842 - y - height} cm /${name} Do Q`;
}

function settingsWithInvoiceTemplate(settings: any, invoice: any = {}) {
  const source = settings?.toJSON?.() || { ...(settings || {}) };
  const templates = Array.isArray(source.reusableBlocks)
    ? source.reusableBlocks.filter((item: any) => item?.type === "fabric-template")
    : [];
  const invoiceTemplate = invoice?.templateId
    ? templates.find((item: any) => String(item.id) === String(invoice.templateId))
    : null;
  const active = invoiceTemplate || templates.find((item: any) => item.active) || templates.find((item: any) => String(item.id) === String(source.activeTemplateId)) || templates[0];
  if (Array.isArray(active?.fields) && active.fields.length) {
    return {
      ...source,
      fields: active.fields,
      activeTemplateId: active.id || source.activeTemplateId,
      activeTemplateName: active.name || source.activeTemplateName,
    };
  }
  return source;
}

function fieldGeometry(field: any, metrics: any) {
  const raw = field.raw || field;
  const hasNormalized = Number.isFinite(Number(raw.pageX)) && Number.isFinite(Number(raw.pageY));
  const x = Number(field.x ?? (hasNormalized ? Number(raw.pageX || 0) * metrics.scaleX : (Number(raw.left || 0) - metrics.pageLeft) * metrics.scaleX));
  const y = Number(field.y ?? (hasNormalized ? Number(raw.pageY || 0) * metrics.scaleY : (Number(raw.top || 0) - metrics.pageTop) * metrics.scaleY));
  const width = Number(field.width ?? ((raw.scaledWidth ?? Number(raw.width || 80) * Number(raw.scaleX ?? 1)) * metrics.scaleX));
  const height = Number(field.height ?? ((raw.scaledHeight ?? Number(raw.height || 30) * Number(raw.scaleY ?? 1)) * metrics.scaleY));
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

function drawInvoiceTable(field: any, data: Record<string, unknown>, metrics: any) {
  const raw = field.raw || field;
  const meta = raw.invoiceTable || field.invoiceTable;
  if (!meta) return [];
  const { x, y, width, height } = fieldGeometry(field, metrics);
  const cols = Math.max(1, Number(meta.cols || meta.headers?.length || 1));
  const rows = Math.max(1, Number(meta.rows || 1));
  const style = {
    borderColor: "#cbd5e1",
    borderWidth: 0.5,
    borderStyle: "solid",
    headerBackground: "#0f172a",
    headerTextColor: "#ffffff",
    bodyTextColor: "#334155",
    bodyBackground: "#ffffff",
    alternateRowBackground: "#f8fafc",
    useAlternateRows: false,
    padding: 6,
    ...(meta.style || {}),
  };
  const rowHeights = Array.from({ length: rows }).map((_, index) => Number(meta.rowHeights?.[index] || height / rows));
  const rowTotal = rowHeights.reduce((sum, value) => sum + value, 0) || 1;
  const scaledRows = rowHeights.map((value) => (value / rowTotal) * height);
  const colWidths = Array.from({ length: cols }).map((_, index) => Number(meta.colWidths?.[index] || width / cols));
  const colTotal = colWidths.reduce((sum, value) => sum + value, 0) || 1;
  const scaledCols = colWidths.map((value) => (value / colTotal) * width);
  const headers = Array.from({ length: cols }).map((_, index) => meta.headers?.[index] || `Column ${index + 1}`);
  const cells = Array.isArray(meta.cells) ? meta.cells : [];
  const ops: string[] = [];
  const borderWidth = Number(style.borderWidth || 0);

  let currentX = x;
  headers.forEach((header, index) => {
    const colWidth = scaledCols[index];
    ops.push(colorRectOp(currentX, y, colWidth, scaledRows[0], style.headerBackground, style.borderColor, borderWidth));
    ops.push(styledTextOp(replaceTokens(String(header), data), currentX + Number(style.padding || 0), y + scaledRows[0] / 2 + 4, Math.max(4, scaledRows[0] * 0.32), style.headerTextColor, { fontWeight: "bold" }));
    currentX += colWidth;
  });

  let currentY = y + scaledRows[0];
  for (let row = 1; row < rows; row += 1) {
    currentX = x;
    for (let col = 0; col < cols; col += 1) {
      const value = cells[row - 1]?.[col] ?? "";
      const colWidth = scaledCols[col];
      const fill = meta.rowColors?.[row] || meta.colColors?.[col] || (style.useAlternateRows && row % 2 === 0 ? style.alternateRowBackground : style.bodyBackground);
      ops.push(colorRectOp(currentX, currentY, colWidth, scaledRows[row], fill, style.borderColor, borderWidth));
      ops.push(styledTextOp(replaceTokens(String(value), data), currentX + Number(style.padding || 0), currentY + scaledRows[row] / 2 + 4, Math.max(4, scaledRows[row] * 0.3), style.bodyTextColor, {}));
      currentX += colWidth;
    }
    currentY += scaledRows[row];
  }
  return Number(raw.angle || 0) ? [rotateCenterOp(ops.join("\n"), x, y, width, height, raw.angle)] : ops;
}

type PdfImage = {
  name: string;
  buffer: Buffer;
  width: number;
  height: number;
};

function drawFieldObject(field: any, data: Record<string, unknown>, metrics: any, images: PdfImage[] = []): string[] {
  const raw = field.raw || field;
  const type = String(raw.type || field.type || "").toLowerCase();
  const geometry = fieldGeometry(field, metrics);
  const x = geometry.x;
  const y = geometry.y;
  const width = geometry.width;
  const height = geometry.height;
  const fill = raw.fill || field.style?.fill || field.style?.color || "#111827";
  const stroke = raw.stroke || field.style?.stroke || "#000000";
  const strokeWidth = Number(raw.strokeWidth ?? field.style?.strokeWidth ?? 0);
  const ops: string[] = [];

  if ((type === "group" || type === "table") && (raw.invoiceTable || field.invoiceTable)) {
    ops.push(...drawInvoiceTable(field, data, metrics));
  } else if (type === "text" || type === "i-text") {
    const content = replaceTokens(raw.text || field.content || field.label || "", data);
    const fontSize = Math.max(1, Number(field.size ?? (Number(raw.fontSize || 10) * metrics.scaleY)));
    ops.push(...String(content).split(/\r?\n/).map((line, index) => styledTextOp(line, x, y + index * (fontSize + 4), fontSize, fill, raw)));
  } else if (type === "rect") {
    ops.push(rotateCenterOp(colorRectOp(x, y, width, height, fill, stroke, strokeWidth), x, y, width, height, raw.angle));
  } else if (type === "circle") {
    ops.push(rotateCenterOp(colorCircleOp(x, y, Math.max(1, Math.min(width, height) / 2), fill, stroke, strokeWidth), x, y, width, height, raw.angle));
  } else if (type === "triangle") {
    ops.push(rotateCenterOp(colorTriangleOp(x, y, width, height, fill, stroke, strokeWidth), x, y, width, height, raw.angle));
  } else if (type === "group" && Array.isArray(raw.objects)) {
    raw.objects.forEach((child: any) => {
      const childWidth = Math.max(1, Number(child.width || 40) * Number(child.scaleX ?? 1) * metrics.scaleX);
      const childHeight = Math.max(1, Number(child.height || 20) * Number(child.scaleY ?? 1) * metrics.scaleY);
      const childField = {
        ...field,
        raw: child,
        x: x + (Number(child.left || 0) + Number(raw.width || 0) / 2) * metrics.scaleX,
        y: y + (Number(child.top || 0) + Number(raw.height || 0) / 2) * metrics.scaleY,
        width: childWidth,
        height: childHeight,
        size: Math.max(1, Number(child.fontSize || 10) * metrics.scaleY),
      };
      ops.push(...drawFieldObject(childField, data, metrics, images));
    });
  } else if (type === "image") {
    const image = imageFromDataUrl(raw.src || field.src, width, height);
    if (image) {
      const name = `Im${images.length + 1}`;
      images.push({ name, ...image });
      ops.push(rotateCenterOp(imageOp(name, x, y, width, height), x, y, width, height, raw.angle));
    }
  }

  return ops;
}

function buildPdf(lines: string[], images: PdfImage[] = []) {
  const objects: Array<string | { dict: string; stream: Buffer }> = [];
  const add = (value: string | { dict: string; stream: Buffer }) => {
    objects.push(value);
    return objects.length;
  };
  const content = lines.join("\n");
  const addStream = (dict: string, buffer: Buffer) => add({
    dict: `<< ${dict} /Length ${buffer.length} >>`,
    stream: buffer,
  });
  const contentId = addStream("", Buffer.from(content, "utf8"));
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const boldFontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const italicFontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>");
  const boldItalicFontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique >>");
  const imageIds = images.map((image) => addStream(
    `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    image.buffer,
  ));
  const xObjectResources = imageIds.length
    ? ` /XObject << ${images.map((image, index) => `/${image.name} ${imageIds[index]} 0 R`).join(" ")} >>`
    : "";
  const pageId = objects.length + 1;
  const pagesId = pageId + 1;
  add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R /F3 ${italicFontId} 0 R /F4 ${boldItalicFontId} 0 R >>${xObjectResources} >> /Contents ${contentId} 0 R >>`);
  add(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const chunks = [Buffer.from("%PDF-1.4\n", "utf8")];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`, "utf8"));
    if (typeof object === "string") {
      chunks.push(Buffer.from(`${object}\n`, "utf8"));
    } else {
      chunks.push(Buffer.from(`${object.dict}\nstream\n`, "utf8"), object.stream, Buffer.from("\nendstream\n", "utf8"));
    }
    chunks.push(Buffer.from("endobj\n", "utf8"));
  });
  const xref = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, "utf8"));
  offsets.slice(1).forEach((offset) => chunks.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`, "utf8")));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`, "utf8"));
  return Buffer.concat(chunks);
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
  const convenienceCharge = Number(input.convenienceCharge || 0);
  const convenienceChargeGst = Number(input.convenienceChargeGst || 0);
  const totalCharges = convenienceCharge + convenienceChargeGst;
  const configuredChargeGstPercent = Number(input.taxDetails?.convenienceChargeGstPercent ?? 0);
  const derivedChargeGstPercent = convenienceCharge > 0 && convenienceChargeGst > 0
    ? (convenienceChargeGst / convenienceCharge) * 100
    : 0;
  const displayChargeGstPercent = configuredChargeGstPercent > 0
    ? configuredChargeGstPercent
    : Math.abs(derivedChargeGstPercent - Math.round(derivedChargeGstPercent)) < 0.1
      ? Math.round(derivedChargeGstPercent)
      : Number(derivedChargeGstPercent.toFixed(2));
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
    planAmount: formatCurrency(input.subtotal ?? firstItem.price ?? input.amount),
    baseAmount: formatCurrency(input.subtotal ?? firstItem.price ?? input.amount),
    discountAmount: formatCurrency(input.discountTotal || 0),
    taxPercent: Number(input.taxDetails?.taxPercent ?? input.items?.[0]?.tax ?? 0),
    taxAmount: formatCurrency(input.taxTotal || 0),
    convenienceCharge: formatCurrency(convenienceCharge),
    convenienceChargeGstPercent: displayChargeGstPercent,
    convenienceChargeGst: formatCurrency(convenienceChargeGst),
    totalCharges: formatCurrency(totalCharges),
    finalAmount: formatCurrency(input.grandTotal || input.amount),
    amount: formatCurrency(input.amount || input.grandTotal),
    totalAmount: formatCurrency(input.grandTotal || input.amount),
    currency: input.currency || "INR",
    paymentStatus: String(input.status || "paid").toUpperCase(),
    transactionId: input.transactionId || "",
    paidStampText: input.paidStampText || "PAID",
  };
}

function activeTemplate(settings: any) {
  const templates = Array.isArray(settings?.reusableBlocks)
    ? settings.reusableBlocks.filter((item: any) => item?.type === "fabric-template")
    : [];
  return templates.find((item: any) => item.active) || templates[0] || null;
}

export function getActiveInvoiceTemplate(settings: any) {
  return activeTemplate(settings);
}

export async function renderInvoicePdf(invoice: any, settings: any, extras: Record<string, unknown> = {}) {
  const source = { ...(invoice.toJSON?.() || invoice), ...extras };
  const effectiveSettings = settingsWithInvoiceTemplate(settings, source);
  const data = invoiceData({ ...source, paidStampText: effectiveSettings.paidStampText });
  const mappedFields = Array.isArray(effectiveSettings.fields)
    ? effectiveSettings.fields.filter((field: any) => field?.enabled !== false && (field?.raw || String(field?.label || field?.content || "").trim()))
    : [];
  if (mappedFields.length) {
    const metrics = pageMetricsFromFields(mappedFields);
    const images: PdfImage[] = [];
    const content = [
      fillRectOp(0, 0, 595, 842, 1),
      ...mappedFields
        .sort((left: any, right: any) => Number(left.zIndex || 0) - Number(right.zIndex || 0))
        .flatMap((field: any) => drawFieldObject(field, data, metrics, images)),
    ];
    return buildPdf(content, images);
  }
  const items = Array.isArray(source.items) && source.items.length
    ? source.items
    : [{ product: data.planName, description: data.productDescription, quantity: data.quantity, price: source.amount, discount: 0, tax: 0, total: source.amount }];
  const companyLines = [
    effectiveSettings.companyName || "Krita NEET JEE",
    effectiveSettings.companyAddress,
    effectiveSettings.companyEmail,
    effectiveSettings.companyPhone,
  ].filter(Boolean);
  const customerLines = [
    source.customerCompany?.name || data.userName,
    source.customerCompany?.email || data.userEmail,
    source.customerCompany?.phone || data.userMobile,
    source.customerCompany?.address || data.customerAddress,
    source.customerCompany?.gstin ? `GSTIN: ${source.customerCompany.gstin}` : "",
  ].filter(Boolean);

  const content: string[] = [
    fillRectOp(0, 0, 595, 96, 0.97),
    ...textLines(companyLines.join("\n"), 42, 34, 10, 13),
    textOp(String(effectiveSettings.templateTitle || "Tax Invoice").toUpperCase(), 392, 34, 14),
    textOp("INVOICE", 392, 54, 30),
    lineOp(42, 112, 553, 112),
    textOp(`Invoice No: ${data.invoiceNumber || "-"}`, 42, 136, 10),
    textOp(`Invoice Date: ${data.invoiceDate || "-"}`, 42, 153, 10),
    textOp(`Due Date: ${data.dueDate || "-"}`, 42, 170, 10),
    textOp(`Status: ${data.paymentStatus || "-"}`, 392, 136, 10),
    textOp(`Transaction ID: ${data.transactionId || "-"}`, 392, 153, 10),
    textOp("Bill To", 42, 214, 13),
    rectOp(42, 226, 230, 88),
    ...textLines(customerLines.join("\n") || "Customer", 54, 246, 9, 13),
    textOp("Payment Summary", 332, 214, 13),
    rectOp(332, 226, 221, 88),
    textOp(`Subtotal: ${data.baseAmount}`, 344, 246, 9),
    textOp(`Discount: ${data.discountAmount}`, 344, 263, 9),
    textOp(`Tax: ${data.taxAmount}`, 344, 280, 9),
    textOp(`Convenience: ${data.convenienceCharge}`, 344, 297, 9),
    textOp(`GST on Charges: ${data.convenienceChargeGst}`, 344, 314, 9),
    textOp(`Total: ${data.totalAmount}`, 344, 334, 11),
    textOp(String(effectiveSettings.productDetailsTitle || "Product Details"), 42, 348, 13),
    fillRectOp(42, 362, 511, 24, 0.92),
    textOp("Item", 54, 378, 9),
    textOp("Qty", 300, 378, 9),
    textOp("Rate", 350, 378, 9),
    textOp("Discount", 418, 378, 9),
    textOp("Amount", 500, 378, 9),
  ];

  items.slice(0, 8).forEach((item: any, index: number) => {
    const y = 406 + index * 28;
    const amount = Number((item.total ?? (Number(item.quantity || 1) * Number(item.price || 0) - Number(item.discount || 0))) || 0);
    content.push(
      lineOp(42, y - 13, 553, y - 13),
      textOp(String(item.product || item.description || data.planName || "Item").slice(0, 45), 54, y, 9),
      textOp(String(item.quantity || 1), 304, y, 9),
      textOp(`${source.currency || "INR"} ${Number(item.price || 0).toFixed(2)}`, 350, y, 9),
      textOp(`${source.currency || "INR"} ${Number(item.discount || 0).toFixed(2)}`, 418, y, 9),
      textOp(`${source.currency || "INR"} ${amount.toFixed(2)}`, 500, y, 9),
    );
  });

  content.push(
    lineOp(42, 634, 553, 634),
    textOp(`Grand Total: ${data.totalAmount}`, 392, 662, 14),
    ...(source.notes ? [textOp("Notes", 42, 680, 11), ...textLines(source.notes, 42, 696, 9, 13)] : []),
    ...(source.terms ? [textOp("Terms", 42, 736, 11), ...textLines(source.terms, 42, 752, 9, 13)] : []),
    textOp(effectiveSettings.footerText || "This is a computer-generated invoice.", 42, 802, 8),
  );
  return buildPdf(content);
}

export async function regenerateInvoicePdf(invoice: any, settings?: any, extras: Record<string, unknown> = {}) {
  const resolvedSettings = settings || await getInvoiceSettings();
  const pdf = await renderInvoicePdf(invoice, resolvedSettings, extras);
  invoice.pdfPath = await saveInvoicePdf(pdf, invoice.invoiceNumber);
  return pdf;
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
  const template = activeTemplate(settings);
  const subtotal = Number(subscription.baseAmount || subscription.amount || 0);
  const discountTotal = Number(subscription.discountAmount || 0);
  const taxPercent = Number(subscription.taxPercent ?? settings.defaultTaxPercent ?? 0);
  const taxableAmount = Math.max(0, subtotal - discountTotal);
  const taxTotal = Number(subscription.taxAmount ?? Math.round(((taxableAmount * taxPercent) / 100) * 100) / 100);
  const amountBeforeCharges = Number(subscription.amountBeforeCharges ?? Math.round((taxableAmount + taxTotal) * 100) / 100);
  const convenienceChargePercent = Number(subscription.convenienceChargePercent ?? settings.defaultConvenienceChargePercent ?? 0);
  const convenienceCharge = Number(subscription.convenienceCharge ?? Math.round(((amountBeforeCharges * convenienceChargePercent) / 100) * 100) / 100);
  const convenienceChargeGstPercent = Number(subscription.convenienceChargeGstPercent ?? settings.defaultConvenienceChargeGstPercent ?? 0);
  const convenienceChargeGst = Number(subscription.convenienceChargeGst ?? Math.floor(((convenienceCharge * convenienceChargeGstPercent) / 100) * 100) / 100);
  const grandTotal = Number(subscription.finalAmount ?? subscription.amount ?? Math.round((amountBeforeCharges + convenienceCharge + convenienceChargeGst) * 100) / 100);
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
    amount: grandTotal,
    subtotal,
    discountTotal,
    taxTotal,
    convenienceCharge,
    convenienceChargeGst,
    grandTotal,
    currency: subscription.currency || "INR",
    status: "paid",
    taxDetails: {
      type: "GST",
      taxPercent,
      taxableAmount,
      amountBeforeCharges,
      convenienceChargePercent,
      convenienceChargeGstPercent,
    },
    templateId: template?.id || settings.activeTemplateId || "",
    templateName: template?.name || settings.activeTemplateName || "",
    transactionId: subscription.razorpayPaymentId || subscription.razorpayOrderId || "",
    invoiceDate: new Date(),
    dueDate: subscription.endDate,
    items: [{
      product: plan?.name || subscription.planId,
      description: "Premium subscription purchase",
      quantity: 1,
      price: subtotal,
      discount: discountTotal,
      tax: taxPercent,
      total: amountBeforeCharges,
    }],
    emailStatus: "pending",
    issuedAt: new Date(),
    paymentHistory: [{
      status: "paid",
      amount: grandTotal,
      transactionId: subscription.razorpayPaymentId || subscription.razorpayOrderId || "",
      paidAt: subscription.transactionDate || new Date(),
      note: "Subscription payment received",
      razorpayOrderId: subscription.razorpayOrderId || "",
      razorpayPaymentId: subscription.razorpayPaymentId || "",
      convenienceCharge,
      convenienceChargeGst,
    }],
    activityLogs: [{ action: "created", message: "Invoice generated from purchase", at: new Date() }],
  });
  logger.info({ invoiceNumber, subscriptionId, amount: grandTotal, taxTotal, discountTotal }, "Invoice generated");

  const data = invoiceData({ ...invoice.toJSON(), userMobile: user?.mobile || "", planName: plan?.name, paidStampText: settings.paidStampText });
  const pdf = await regenerateInvoicePdf(invoice, settings, { userMobile: user?.mobile || "", planName: plan?.name });
  await invoice.save();

  if (settings.enabled && settings.emailEnabled && invoice.userEmail) {
    try {
      const result = await sendEmail({
        smtp: settings.smtp || {},
        to: invoice.userEmail,
        subject: `Invoice ${invoice.invoiceNumber} from ${settings.companyName}`,
        text: `Hi ${invoice.userName || "Learner"},\n\nYour payment was successful and your invoice PDF is attached.\n\nInvoice: ${invoice.invoiceNumber}\nProduct: ${data.planName}\nPlan Amount: ${data.baseAmount}\nDiscount: ${data.discountAmount}\nTax (${data.taxPercent}%): ${data.taxAmount}\nConvenience Charges: ${data.convenienceCharge}\nGST on Convenience Charges (${data.convenienceChargeGstPercent}%): ${data.convenienceChargeGst}\nTotal Paid: ${data.totalAmount}\nPayment Status: ${data.paymentStatus}\nRazorpay Payment ID: ${data.transactionId || "-"}\n\nFor support, contact ${settings.companyEmail || settings.smtp?.fromEmail || "support"}.\n\n${settings.companyName}`,
        attachments: [{ filename: `${invoice.invoiceNumber}.pdf`, contentType: "application/pdf", content: pdf }],
      });
      invoice.emailStatus = result.skipped ? "skipped" : "sent";
      invoice.emailError = result.skipped ? result.reason : "";
      invoice.sentAt = result.skipped ? undefined : new Date();
      await invoice.save();
      logger.info({ invoiceNumber: invoice.invoiceNumber, to: invoice.userEmail, emailStatus: invoice.emailStatus }, "Invoice email processed");
    } catch (error) {
      invoice.emailStatus = "failed";
      invoice.emailError = error instanceof Error ? error.message : "Email failed";
      await invoice.save();
      logger.warn({ err: error, invoiceNumber: invoice.invoiceNumber }, "Invoice email failed");
    }
  } else {
    invoice.emailStatus = "skipped";
    invoice.emailError = invoice.userEmail ? "Invoice email disabled" : "User email missing";
    await invoice.save();
    logger.info({ invoiceNumber: invoice.invoiceNumber, reason: invoice.emailError }, "Invoice email skipped");
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
