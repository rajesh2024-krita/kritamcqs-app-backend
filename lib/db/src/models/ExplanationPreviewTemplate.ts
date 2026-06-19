import mongoose, { Schema, Document } from "mongoose";

export interface IExplanationPreviewTemplate extends Document {
  id: string;
  key: string;
  name: string;
  layout: Record<string, unknown>;
  status: "draft" | "published";
  publishedAt?: Date;
}

const ExplanationPreviewTemplateSchema = new Schema<IExplanationPreviewTemplate>(
  {
    key: { type: String, required: true, unique: true, trim: true, default: "default" },
    name: { type: String, required: true, trim: true, default: "Default Explanation Preview" },
    layout: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["draft", "published"], default: "published", index: true },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

export const ExplanationPreviewTemplate =
  mongoose.models["ExplanationPreviewTemplate"] ??
  mongoose.model<IExplanationPreviewTemplate>("ExplanationPreviewTemplate", ExplanationPreviewTemplateSchema);
