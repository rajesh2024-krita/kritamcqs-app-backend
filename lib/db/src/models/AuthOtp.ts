import mongoose, { Schema, Document } from "mongoose";

export interface IAuthOtp extends Document {
  id: string;
  email: string;
  purpose: string;
  otpHash: string;
  expiresAt: Date;
  attempts: number;
  resendCount: number;
  verifiedAt?: Date;
  resetTokenHash?: string;
  used: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AuthOtpSchema = new Schema<IAuthOtp>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    purpose: { type: String, required: true, default: "password_reset", index: true },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    attempts: { type: Number, default: 0 },
    resendCount: { type: Number, default: 0 },
    verifiedAt: Date,
    resetTokenHash: { type: String, index: true },
    used: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.otpHash;
        delete ret.resetTokenHash;
        return ret;
      },
    },
  },
);

AuthOtpSchema.index({ email: 1, purpose: 1, used: 1, createdAt: -1 });

export const AuthOtp = mongoose.models["AuthOtp"] ?? mongoose.model<IAuthOtp>("AuthOtp", AuthOtpSchema);
