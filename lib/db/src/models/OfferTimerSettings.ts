import mongoose, { Schema, Document } from "mongoose";

export const offerTimerAudienceValues = [
  "all",
  "premium",
  "nonPremium",
  "newRegistered",
  "newRegisteredNonPremium",
] as const;

export type OfferTimerAudience = (typeof offerTimerAudienceValues)[number];

export interface IOfferTimerSettings extends Document {
  id: string;
  key: string;
  enabled: boolean;
  title?: string;
  subtitle?: string;
  description?: string;
  image?: string;
  ctaText?: string;
  ctaLink?: string;
  startAt?: Date;
  endAt?: Date;
  audience: OfferTimerAudience;
  widgetStyle?: Record<string, unknown>;
  popupStyle?: Record<string, unknown>;
  updatedById?: mongoose.Types.ObjectId;
}

const OfferTimerSettingsSchema = new Schema<IOfferTimerSettings>(
  {
    key: { type: String, default: "app-offer-timer", unique: true, index: true },
    enabled: { type: Boolean, default: false, index: true },
    title: { type: String, default: "" },
    subtitle: { type: String, default: "" },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    ctaText: { type: String, default: "" },
    ctaLink: { type: String, default: "" },
    startAt: { type: Date },
    endAt: { type: Date },
    audience: { type: String, enum: offerTimerAudienceValues, default: "all", index: true },
    widgetStyle: { type: Schema.Types.Mixed, default: {} },
    popupStyle: { type: Schema.Types.Mixed, default: {} },
    updatedById: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export const OfferTimerSettings =
  mongoose.models["OfferTimerSettings"] ??
  mongoose.model<IOfferTimerSettings>("OfferTimerSettings", OfferTimerSettingsSchema);
