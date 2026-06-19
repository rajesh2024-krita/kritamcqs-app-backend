import mongoose, { Schema, Document } from "mongoose";

export interface ISubscriptionPageTemplate extends Document {
  id: string;
  name: string;
  slug: string;
  description?: string;
  blocks: Array<{ id?: string; type: string; props?: Record<string, unknown>; sortOrder?: number }>;
  status: "draft" | "published" | "archived";
  isDefault: boolean;
  publishedAt?: Date;
}

const BuilderBlockSchema = new Schema(
  {
    id: { type: String, trim: true },
    type: { type: String, required: true, trim: true },
    props: { type: Schema.Types.Mixed, default: {} },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false },
);

const SubscriptionPageTemplateSchema = new Schema<ISubscriptionPageTemplate>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true, index: true },
    description: { type: String, trim: true, default: "" },
    blocks: { type: [BuilderBlockSchema], default: [] },
    status: { type: String, enum: ["draft", "published", "archived"], default: "draft", index: true },
    isDefault: { type: Boolean, default: false },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

SubscriptionPageTemplateSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: "published" } },
);

export const SubscriptionPageTemplate =
  mongoose.models["SubscriptionPageTemplate"] ??
  mongoose.model<ISubscriptionPageTemplate>("SubscriptionPageTemplate", SubscriptionPageTemplateSchema);
