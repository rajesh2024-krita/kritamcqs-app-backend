import mongoose, { Schema, Document } from "mongoose";

export interface ISubscriptionFreeCard extends Document {
  id: string;
  key: string;
  title: string;
  subtitle?: string;
  items: string[];
  active: boolean;
  sortOrder: number;
}

const SubscriptionFreeCardSchema = new Schema<ISubscriptionFreeCard>(
  {
    key: { type: String, required: true, unique: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true, default: "" },
    items: [{ type: String, trim: true }],
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 1 },
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

export const SubscriptionFreeCard =
  mongoose.models["SubscriptionFreeCard"] ??
  mongoose.model<ISubscriptionFreeCard>("SubscriptionFreeCard", SubscriptionFreeCardSchema);
