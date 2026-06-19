import mongoose, { Schema, Document } from "mongoose";

export interface IPolicyPage extends Document {
  title: string;
  slug: string;
  type: "privacy" | "terms" | "refund" | "cancellation" | "shipping" | "custom";
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  canonicalUrl?: string;
  noIndex: boolean;
  html?: string;
  css?: string;
  status: "draft" | "published";
  active: boolean;
  publishedAt?: Date;
  sortOrder: number;
}

const PolicyPageSchema = new Schema<IPolicyPage>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    type: { type: String, enum: ["privacy", "terms", "refund", "cancellation", "shipping", "custom"], default: "custom", index: true },
    seoTitle: { type: String, trim: true, default: "" },
    seoDescription: { type: String, trim: true, default: "" },
    seoKeywords: { type: String, trim: true, default: "" },
    ogTitle: { type: String, trim: true, default: "" },
    ogDescription: { type: String, trim: true, default: "" },
    ogImage: { type: String, trim: true, default: "" },
    canonicalUrl: { type: String, trim: true, default: "" },
    noIndex: { type: Boolean, default: false },
    html: { type: String, default: "" },
    css: { type: String, default: "" },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    active: { type: Boolean, default: true, index: true },
    publishedAt: { type: Date },
    sortOrder: { type: Number, default: 1 },
  },
  { timestamps: true },
);

export const PolicyPage = mongoose.models["PolicyPage"] ?? mongoose.model<IPolicyPage>("PolicyPage", PolicyPageSchema);
