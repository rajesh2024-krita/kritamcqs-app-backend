import mongoose, { Schema, Document } from "mongoose";

export type AppleSubscriptionStatus = "active" | "expired" | "cancelled" | "failed" | "refunded";

export interface IUserSubscription extends Document {
  userId: string;
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  receiptData?: string;
  purchaseDate: Date;
  expiryDate: Date;
  subscriptionStatus: AppleSubscriptionStatus;
  autoRenewStatus: boolean;
  platform: "ios";
  latestWebhookEvent?: {
    type?: string;
    subtype?: string;
    notificationUUID?: string;
    signedDate?: Date;
  };
  environment?: "Production" | "Sandbox";
  createdAt: Date;
  updatedAt: Date;
}

const UserSubscriptionSchema = new Schema<IUserSubscription>(
  {
    userId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    transactionId: { type: String, required: true, index: true },
    // This is the stable key across the initial purchase and every renewal.
    originalTransactionId: { type: String, required: true, unique: true, index: true },
    receiptData: { type: String, select: false },
    purchaseDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true, index: true },
    subscriptionStatus: {
      type: String,
      enum: ["active", "expired", "cancelled", "failed", "refunded"],
      required: true,
      default: "active",
      index: true,
    },
    autoRenewStatus: { type: Boolean, default: true },
    platform: { type: String, enum: ["ios"], default: "ios", required: true, index: true },
    latestWebhookEvent: { type: Schema.Types.Mixed },
    environment: { type: String, enum: ["Production", "Sandbox"] },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.receiptData;
        return ret;
      },
    },
  },
);

export const UserSubscription =
  mongoose.models["UserSubscription"] ??
  mongoose.model<IUserSubscription>("UserSubscription", UserSubscriptionSchema);
