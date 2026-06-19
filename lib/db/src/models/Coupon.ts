import mongoose, { Schema, Document } from "mongoose";

export interface ICoupon extends Document {
  id: string;
  code: string;
  type: "amount" | "percent";
  value: number;
  active: boolean;
  validFrom?: Date;
  validUntil?: Date;
  usageLimit?: number;
  usedCount: number;
  description?: string;
}

const CouponSchema = new Schema<ICoupon>(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true, index: true },
    type: { type: String, enum: ["amount", "percent"], required: true },
    value: { type: Number, required: true },
    active: { type: Boolean, default: true, index: true },
    validFrom: Date,
    validUntil: Date,
    usageLimit: Number,
    usedCount: { type: Number, default: 0 },
    description: { type: String, trim: true },
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

export const Coupon = mongoose.models["Coupon"] ?? mongoose.model<ICoupon>("Coupon", CouponSchema);
