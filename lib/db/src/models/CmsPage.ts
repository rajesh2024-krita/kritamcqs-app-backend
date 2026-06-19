import mongoose, { Schema, Document } from "mongoose";

export interface ICmsPage extends Document {
  title: string;
  slug: string;
  metaTitle?: string;
  metaDescription?: string;
  seoKeywords?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  canonicalUrl?: string;
  noIndex: boolean;
  featuredImage?: string;
  menuName?: string;
  parentMenu?: string;
  html?: string;
  css?: string;
  scripts?: string;
  status: "draft" | "published";
  active: boolean;
  showInMenu: boolean;
  sortOrder: number;
  scheduledPublishAt?: Date;
  publishedAt?: Date;
  deletedAt?: Date;
}

const CmsPageSchema = new Schema<ICmsPage>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    metaTitle: { type: String, trim: true, default: "" },
    metaDescription: { type: String, trim: true, default: "" },
    seoKeywords: { type: String, trim: true, default: "" },
    ogTitle: { type: String, trim: true, default: "" },
    ogDescription: { type: String, trim: true, default: "" },
    ogImage: { type: String, trim: true, default: "" },
    canonicalUrl: { type: String, trim: true, default: "" },
    noIndex: { type: Boolean, default: false },
    featuredImage: { type: String, trim: true, default: "" },
    menuName: { type: String, trim: true, default: "" },
    parentMenu: { type: String, trim: true, default: "" },
    html: { type: String, default: "" },
    css: { type: String, default: "" },
    scripts: { type: String, default: "" },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    active: { type: Boolean, default: true, index: true },
    showInMenu: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 1 },
    scheduledPublishAt: { type: Date },
    publishedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

export const CmsPage = mongoose.models["CmsPage"] ?? mongoose.model<ICmsPage>("CmsPage", CmsPageSchema);
