import mongoose, { Schema, Document } from "mongoose";

export interface ISubscription extends Document {
  id: string;
  userId: string;
  planId: string;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  razorpayPaidAmount?: number;
  razorpayFeeAmount?: number;
  razorpayTaxAmount?: number;
  couponCode?: string;
  couponType?: "amount" | "percent";
  couponValue?: number;
  baseAmount?: number;
  discountAmount?: number;
  taxPercent?: number;
  taxAmount?: number;
  amountBeforeCharges?: number;
  convenienceChargePercent?: number;
  convenienceCharge?: number;
  convenienceChargeGstPercent?: number;
  convenienceChargeGst?: number;
  finalAmount?: number;
  currency?: string;
  paymentStatus?: "PENDING" | "PAID" | "FAILED";
  transactionDate?: Date;
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
    razorpaySignature: String,
    razorpayPaidAmount: Number,
    razorpayFeeAmount: Number,
    razorpayTaxAmount: Number,
    couponCode: { type: String, trim: true, uppercase: true },
    couponType: { type: String, enum: ["amount", "percent"] },
    couponValue: Number,
    baseAmount: Number,
    discountAmount: Number,
    taxPercent: Number,
    taxAmount: Number,
    amountBeforeCharges: Number,
    convenienceChargePercent: Number,
    convenienceCharge: Number,
    convenienceChargeGstPercent: Number,
    convenienceChargeGst: Number,
    finalAmount: Number,
    currency: { type: String, default: "INR" },
    paymentStatus: { type: String, enum: ["PENDING", "PAID", "FAILED"], default: "PENDING", index: true },
    transactionDate: Date,
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
