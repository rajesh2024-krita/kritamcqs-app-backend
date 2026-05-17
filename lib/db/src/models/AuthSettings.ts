import mongoose, { Schema, Document } from "mongoose";

export interface IAuthSettings extends Document {
  key: string;
  emailPasswordEnabled: boolean;
  googleEnabled: boolean;
  googleClientId?: string;
  googleAndroidClientId?: string;
  googleAndroidPackageName?: string;
  googleAndroidSha1?: string;
  googleClientSecret?: string;
  googleRedirectUrls: string[];
  googleCallbackUrl?: string;
  profileMobileRequired: boolean;
  sessionTimeoutMinutes: number;
  resetOtpExpiryMinutes: number;
  resetOtpMaxAttempts: number;
  resetOtpMaxResends: number;
  resetOtpEmailSubject: string;
  resetOtpEmailTemplate: string;
  createdAt: Date;
  updatedAt: Date;
}

const AuthSettingsSchema = new Schema<IAuthSettings>(
  {
    key: { type: String, default: "default", unique: true, index: true },
    emailPasswordEnabled: { type: Boolean, default: true },
    googleEnabled: { type: Boolean, default: false },
    googleClientId: { type: String, default: "" },
    googleAndroidClientId: { type: String, default: "" },
    googleAndroidPackageName: { type: String, default: "com.kritamcqs.androidapp" },
    googleAndroidSha1: { type: String, default: "CE:34:23:0A:77:79:E5:01:09:10:2C:3C:A9:9C:B3:BF:7B:FD:AF:C4" },
    googleClientSecret: { type: String, default: "" },
    googleRedirectUrls: { type: [String], default: [] },
    googleCallbackUrl: { type: String, default: "" },
    profileMobileRequired: { type: Boolean, default: false },
    sessionTimeoutMinutes: { type: Number, default: 43200, min: 15 },
    resetOtpExpiryMinutes: { type: Number, default: 10, min: 1, max: 60 },
    resetOtpMaxAttempts: { type: Number, default: 5, min: 1, max: 10 },
    resetOtpMaxResends: { type: Number, default: 3, min: 1, max: 10 },
    resetOtpEmailSubject: { type: String, default: "" },
    resetOtpEmailTemplate: { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        if (ret.googleClientSecret) ret.googleClientSecretConfigured = true;
        delete ret.googleClientSecret;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const AuthSettings =
  mongoose.models["AuthSettings"] ?? mongoose.model<IAuthSettings>("AuthSettings", AuthSettingsSchema);
