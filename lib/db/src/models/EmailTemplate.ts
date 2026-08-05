import mongoose, { Schema, Document } from "mongoose";

export interface IEmailTemplate extends Document {
  key: string;
  name: string;
  type: string;
  module: string;
  description?: string;
  subject: string;
  htmlContent: string;
  textContent: string;
  variables: string[];
  sampleData: Record<string, unknown>;
  isActive: boolean;
  isDefault: boolean;
  ctaConfigId: string;
  ctaEnabled: boolean;
  ctaText: string;
  ctaType: string;
  ctaUrl: string;
  openIn: "app" | "website" | "auto";
  buttonColor: string;
  buttonTextColor: string;
  buttonAlignment: "left" | "center" | "right";
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const EmailTemplateSchema = new Schema<IEmailTemplate>(
  {
    key: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    type: { type: String, required: true, enum: ["forgot_password", "otp_verification", "welcome", "notification", "offer", "announcement", "update", "invoice", "registration", "verification", "subscription", "payment_success", "reminder", "broadcast", "expiry", "helpdesk", "contact", "admin_notification"] },
    module: { type: String, default: "notification", index: true },
    description: { type: String, default: "" },
    subject: { type: String, required: true },
    htmlContent: { type: String, default: "" },
    textContent: { type: String, default: "" },
    variables: { type: [String], default: [] },
    sampleData: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    ctaConfigId: { type: String, default: "", index: true },
    ctaEnabled: { type: Boolean, default: false },
    ctaText: { type: String, default: "" },
    ctaType: { type: String, default: "none" },
    ctaUrl: { type: String, default: "" },
    openIn: { type: String, enum: ["app", "website", "auto"], default: "auto" },
    buttonColor: { type: String, default: "#2563eb" },
    buttonTextColor: { type: String, default: "#ffffff" },
    buttonAlignment: { type: String, enum: ["left", "center", "right"], default: "center" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
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

EmailTemplateSchema.index({ key: 1, module: 1 }, { unique: true });

EmailTemplateSchema.pre("validate", function normalizeTemplateKey(next) {
  this.key = String(this.key || "").trim();
  this.module = String(this.module || "").trim();
  next();
});

export const EmailTemplate =
  mongoose.models["EmailTemplate"] ?? mongoose.model<IEmailTemplate>("EmailTemplate", EmailTemplateSchema);
