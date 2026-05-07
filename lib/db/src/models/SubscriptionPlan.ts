import mongoose, { Schema, Document } from "mongoose";

export interface ISubscriptionPlan extends Document {
  id: string;
  planId: string;
  name: string;
  price: number;
  durationMonths: number;
  savings?: string;
  features: string[];
  active: boolean;
  sortOrder: number;
}

const SubscriptionPlanSchema = new Schema<ISubscriptionPlan>(
  {
    planId: { type: String, required: true, unique: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    durationMonths: { type: Number, required: true, min: 1 },
    savings: { type: String, trim: true },
    features: [{ type: String, trim: true }],
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

export const SubscriptionPlan =
  mongoose.models["SubscriptionPlan"] ?? mongoose.model<ISubscriptionPlan>("SubscriptionPlan", SubscriptionPlanSchema);
