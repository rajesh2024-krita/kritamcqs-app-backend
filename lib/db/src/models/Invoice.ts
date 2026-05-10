import mongoose, { Schema, Document } from "mongoose";

export interface IInvoice extends Document {
  id: string;
  invoiceNumber: string;
  userId: string;
  subscriptionId: string;
  planId: string;
  userName?: string;
  userEmail?: string;
  userMobile?: string;
  amount: number;
  currency: string;
  status: "draft" | "sent" | "paid" | "pending" | "overdue" | "cancelled" | "void" | "failed";
  transactionId?: string;
  invoiceDate?: Date;
  dueDate?: Date;
  billingCompany?: Record<string, unknown>;
  customerCompany?: Record<string, unknown>;
  taxDetails?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
  subtotal?: number;
  taxTotal?: number;
  discountTotal?: number;
  grandTotal?: number;
  notes?: string;
  terms?: string;
  signatureUrl?: string;
  logoUrl?: string;
  qrCode?: string;
  templateId?: string;
  templateName?: string;
  shareToken?: string;
  activityLogs?: Array<Record<string, unknown>>;
  paymentHistory?: Array<Record<string, unknown>>;
  pdfPath?: string;
  emailStatus: "pending" | "sent" | "skipped" | "failed";
  emailError?: string;
  sentAt?: Date;
  issuedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const invoiceSchema = new Schema<IInvoice>(
  {
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    subscriptionId: { type: String, required: true, index: true },
    planId: { type: String, required: true },
    userName: String,
    userEmail: String,
    userMobile: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: { type: String, enum: ["draft", "sent", "paid", "pending", "overdue", "cancelled", "void", "failed"], default: "draft", index: true },
    transactionId: String,
    invoiceDate: Date,
    dueDate: Date,
    billingCompany: { type: Schema.Types.Mixed, default: {} },
    customerCompany: { type: Schema.Types.Mixed, default: {} },
    taxDetails: { type: Schema.Types.Mixed, default: {} },
    items: { type: [Schema.Types.Mixed], default: [] },
    subtotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    notes: String,
    terms: String,
    signatureUrl: String,
    logoUrl: String,
    qrCode: String,
    templateId: String,
    templateName: String,
    shareToken: { type: String, index: true },
    activityLogs: { type: [Schema.Types.Mixed], default: [] },
    paymentHistory: { type: [Schema.Types.Mixed], default: [] },
    pdfPath: String,
    emailStatus: { type: String, enum: ["pending", "sent", "skipped", "failed"], default: "pending" },
    emailError: String,
    sentAt: Date,
    issuedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const Invoice = mongoose.models["Invoice"] ?? mongoose.model<IInvoice>("Invoice", invoiceSchema);
