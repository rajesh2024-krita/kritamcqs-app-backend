import mongoose, { Schema, Document } from "mongoose";

export interface ISubscription extends Document {
  id: string;
  userId: string;
  planId: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  couponCode?: string;
  couponType?: "amount" | "percent";
  couponValue?: number;
  baseAmount?: number;
  discountAmount?: number;
  amount: number;
  status: string;
  startDate?: Date;
  endDate?: Date;
  createdAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    userId: { type: String, required: true },
    planId: { type: String, required: true },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    couponCode: { type: String, trim: true, uppercase: true },
    couponType: { type: String, enum: ["amount", "percent"] },
    couponValue: Number,
    baseAmount: Number,
    discountAmount: Number,
    amount: { type: Number, required: true },
    status: { type: String, required: true },
    startDate: Date,
    endDate: Date,
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
  }
);

export const Subscription =
  mongoose.models["Subscription"] ?? mongoose.model<ISubscription>("Subscription", SubscriptionSchema);
