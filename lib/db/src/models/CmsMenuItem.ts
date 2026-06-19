import mongoose, { Schema, Document } from "mongoose";

export interface ICmsMenuItem extends Document {
  label: string;
  pageSlug?: string;
  href?: string;
  linkType: "page" | "section" | "external";
  parentId?: mongoose.Types.ObjectId;
  area: "navbar" | "footer" | "both";
  visible: boolean;
  active: boolean;
  sortOrder: number;
}

const CmsMenuItemSchema = new Schema<ICmsMenuItem>(
  {
    label: { type: String, required: true, trim: true },
    pageSlug: { type: String, trim: true, default: "" },
    href: { type: String, trim: true, default: "" },
    linkType: { type: String, enum: ["page", "section", "external"], default: "page", index: true },
    parentId: { type: Schema.Types.ObjectId, ref: "CmsMenuItem" },
    area: { type: String, enum: ["navbar", "footer", "both"], default: "navbar", index: true },
    visible: { type: Boolean, default: true, index: true },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 1 },
  },
  { timestamps: true },
);

export const CmsMenuItem = mongoose.models["CmsMenuItem"] ?? mongoose.model<ICmsMenuItem>("CmsMenuItem", CmsMenuItemSchema);
