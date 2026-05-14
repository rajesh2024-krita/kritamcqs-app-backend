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
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const EmailTemplateSchema = new Schema<IEmailTemplate>(
  {
    key: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    type: { type: String, required: true, enum: ["forgot_password", "otp_verification", "welcome", "notification", "offer", "announcement", "update", "invoice", "registration", "verification", "subscription", "payment_success", "reminder", "broadcast", "expiry", "helpdesk"] },
    module: { type: String, default: "notification", index: true },
    description: { type: String, default: "" },
    subject: { type: String, required: true },
    htmlContent: { type: String, default: "" },
    textContent: { type: String, default: "" },
    variables: { type: [String], default: [] },
    sampleData: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
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
