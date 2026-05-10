import mongoose, { Schema, Document } from "mongoose";

export interface IPaymentGatewaySettings extends Document {
  id: string;
  provider: "razorpay";
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  enabled: boolean;
  connectionStatus: "not_configured" | "connected" | "failed";
  connectionMessage?: string;
  connectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentGatewaySettingsSchema = new Schema<IPaymentGatewaySettings>(
  {
    provider: { type: String, enum: ["razorpay"], default: "razorpay", index: true },
    razorpayKeyId: { type: String, trim: true },
    razorpayKeySecret: { type: String, trim: true },
    enabled: { type: Boolean, default: false },
    connectionStatus: { type: String, enum: ["not_configured", "connected", "failed"], default: "not_configured" },
    connectionMessage: { type: String, trim: true },
    connectedAt: Date,
  },
  {
    timestamps: true,
    collection: "paymentgatewaysettings",
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

export const PaymentGatewaySettings =
  mongoose.models["PaymentGatewaySettings"]
    ?? mongoose.model<IPaymentGatewaySettings>("PaymentGatewaySettings", PaymentGatewaySettingsSchema);
