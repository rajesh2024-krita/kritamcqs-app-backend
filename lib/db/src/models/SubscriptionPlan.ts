import mongoose, { Schema, Document } from "mongoose";

export interface ISubscriptionPlan extends Document {
  id: string;
  planId: string;
  name: string;
  price: number;
  strikeOutAmount?: number;
  durationMonths: number;
  description?: string;
  savings?: string;
  features: string[];
  active: boolean;
  status?: "active" | "inactive";
  sortOrder: number;
}

const SubscriptionPlanSchema = new Schema<ISubscriptionPlan>(
  {
    planId: { type: String, required: true, unique: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    strikeOutAmount: { type: Number, min: 0, default: 0 },
    durationMonths: { type: Number, required: true, min: 1 },
    description: { type: String, trim: true, default: "" },
    savings: { type: String, trim: true },
    features: [{ type: String, trim: true }],
    active: { type: Boolean, default: true, index: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
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

SubscriptionPlanSchema.pre("validate", function syncStatus(next) {
  if (this.status) this.active = this.status === "active";
  else this.status = this.active === false ? "inactive" : "active";
  next();
});

export const SubscriptionPlan =
  mongoose.models["SubscriptionPlan"] ?? mongoose.model<ISubscriptionPlan>("SubscriptionPlan", SubscriptionPlanSchema);
