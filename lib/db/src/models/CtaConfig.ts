import mongoose, { Schema, Document } from "mongoose";

export interface ICtaConfig extends Document {
  name: string;
  description: string;
  channel: "email" | "push" | "both";
  ctaText: string;
  ctaType: string;
  ctaUrl: string;
  openIn: "app" | "website" | "auto";
  buttonColor: string;
  buttonTextColor: string;
  buttonAlignment: "left" | "center" | "right";
  isActive: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const CtaConfigSchema = new Schema<ICtaConfig>(
  {
    name: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: "", trim: true },
    channel: { type: String, enum: ["email", "push", "both"], default: "both", index: true },
    ctaText: { type: String, default: "", trim: true },
    ctaType: { type: String, default: "none", trim: true, index: true },
    ctaUrl: { type: String, default: "", trim: true },
    openIn: { type: String, enum: ["app", "website", "auto"], default: "auto" },
    buttonColor: { type: String, default: "#2563eb" },
    buttonTextColor: { type: String, default: "#ffffff" },
    buttonAlignment: { type: String, enum: ["left", "center", "right"], default: "center" },
    isActive: { type: Boolean, default: true, index: true },
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

export const CtaConfig =
  mongoose.models["CtaConfig"] ?? mongoose.model<ICtaConfig>("CtaConfig", CtaConfigSchema);
