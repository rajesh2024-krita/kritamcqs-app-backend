import mongoose, { Schema, Document } from "mongoose";

export interface IInvoiceSettings extends Document {
  key: string;
  enabled: boolean;
  emailEnabled: boolean;
  companyName: string;
  companyAddress?: string;
  companyEmail?: string;
  companyPhone?: string;
  logoUrl?: string;
  templateTitle: string;
  templateIntro: string;
  footerText: string;
  productDetailsTitle: string;
  paidStampText: string;
  defaultTaxPercent?: number;
  defaultConvenienceChargePercent?: number;
  defaultConvenienceChargeGstPercent?: number;
  fields: Array<{ id: string; label: string; x: number; y: number; size: number; enabled: boolean }>;
  activeTemplateId?: string;
  activeTemplateName?: string;
  smtp: {
    host?: string;
    port?: number;
    secure?: boolean;
    user?: string;
    pass?: string;
    fromName?: string;
    fromEmail?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const fieldSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, default: "text" },
    label: { type: String, default: "" },
    content: { type: String, default: "" },
    src: { type: String, default: "" },
    x: { type: Number, default: 48 },
    y: { type: Number, default: 120 },
    width: { type: Number, default: 120 },
    height: { type: Number, default: 80 },
    size: { type: Number, default: 10 },
    rotation: { type: Number, default: 0 },
    opacity: { type: Number, default: 1 },
    zIndex: { type: Number, default: 1 },
    style: { type: Schema.Types.Mixed, default: {} },
    table: { type: Schema.Types.Mixed, default: null },
    shape: { type: Schema.Types.Mixed, default: null },
    locked: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
  },
  { _id: false, strict: false },
);

const invoiceSettingsSchema = new Schema<IInvoiceSettings>(
  {
    key: { type: String, default: "default", unique: true, index: true },
    enabled: { type: Boolean, default: true },
    emailEnabled: { type: Boolean, default: true },
    companyName: { type: String, default: "Krita NEET JEE" },
    companyAddress: { type: String, default: "" },
    companyEmail: { type: String, default: "" },
    companyPhone: { type: String, default: "" },
    logoUrl: { type: String, default: "" },
    templateTitle: { type: String, default: "Tax Invoice" },
    templateIntro: { type: String, default: "Thank you for your purchase. Your subscription payment has been received." },
    footerText: { type: String, default: "This is a computer-generated invoice." },
    productDetailsTitle: { type: String, default: "Product Details" },
    paidStampText: { type: String, default: "PAID" },
    defaultTaxPercent: { type: Number, default: 0, min: 0, max: 100 },
    defaultConvenienceChargePercent: { type: Number, default: 0, min: 0, max: 100 },
    defaultConvenienceChargeGstPercent: { type: Number, default: 0, min: 0, max: 100 },
    fields: { type: [fieldSchema], default: [] },
    activeTemplateId: { type: String, default: "" },
    activeTemplateName: { type: String, default: "" },
    page: { type: Schema.Types.Mixed, default: { size: "A4", orientation: "portrait", margin: 32, snapToGrid: true, gridSize: 10 } },
    reusableBlocks: { type: [Schema.Types.Mixed], default: [] },
    versions: { type: [Schema.Types.Mixed], default: [] },
    defaultTemplate: { type: Boolean, default: true },
    smtp: {
      host: { type: String, default: "" },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      user: { type: String, default: "" },
      pass: { type: String, default: "" },
      fromName: { type: String, default: "Krita Admin" },
      fromEmail: { type: String, default: "" },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        if (ret.smtp?.pass) ret.smtp.hasPassword = true;
        if (ret.smtp) delete ret.smtp.pass;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const InvoiceSettings =
  mongoose.models["InvoiceSettings"] ?? mongoose.model<IInvoiceSettings>("InvoiceSettings", invoiceSettingsSchema);
