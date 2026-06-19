import mongoose, { Schema, Document } from "mongoose";

export interface IDashboardCarouselBanner extends Document {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl: string;
  redirectLink?: string;
  imagePositionX?: number;
  imagePositionY?: number;
  displayOrder: number;
  enabled: boolean;
}

const DashboardCarouselBannerSchema = new Schema<IDashboardCarouselBanner>(
  {
    title: { type: String, trim: true, default: "" },
    subtitle: { type: String, trim: true, default: "" },
    imageUrl: { type: String, required: true, trim: true },
    redirectLink: { type: String, trim: true, default: "" },
    imagePositionX: { type: Number, default: 50, min: 0, max: 100 },
    imagePositionY: { type: Number, default: 50, min: 0, max: 100 },
    displayOrder: { type: Number, default: 0, index: true },
    enabled: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

export const DashboardCarouselBanner =
  mongoose.models["DashboardCarouselBanner"] ??
  mongoose.model<IDashboardCarouselBanner>("DashboardCarouselBanner", DashboardCarouselBannerSchema);
