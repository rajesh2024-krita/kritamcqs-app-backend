import mongoose, { Schema, Document } from "mongoose";

export interface IOtp extends Document {
  id: string;
  mobile: string;
  otp: string;
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
}

const OtpSchema = new Schema<IOtp>(
  {
    mobile: { type: String, required: true },
    otp: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
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

export const Otp = mongoose.models["Otp"] ?? mongoose.model<IOtp>("Otp", OtpSchema);
