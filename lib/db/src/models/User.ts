import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  id: string;
  mobile: string;
  email?: string;
  passwordHash?: string;
  googleId?: string;
  firebaseUid?: string;
  appleId?: string;
  loginProvider?: "EMAIL" | "GOOGLE" | "APPLE";
  appleUserId?: string;
  appleEmail?: string;
  isAppleLogin?: boolean;
  authTypes: string[];
  name?: string;
  address?: string;
  examMode?: string;
  level?: string;
  onboardingComplete: boolean;
  mobileVerified: boolean;
  emailVerified?: boolean;
  requiresProfileCompletion?: boolean;
  country?: string;
  state?: string;
  city?: string;
  userType?: string;
  profileImage?: string;
  fcmTokens?: string[];
  fcmTokenLastUpdated?: Date;
  isActive?: boolean;
  isBlocked?: boolean;
  lastLoginAt?: Date;
  isPremium: boolean;
  premiumExpiresAt?: Date;
  premiumPlan?: string;
  premiumExpiry?: Date;
  paymentPlatform?: "ios" | "android" | "web";
  lastPurchase?: {
    subscriptionId?: string;
    planId?: string;
    planAmount?: number;
    discountAmount?: number;
    taxAmount?: number;
    convenienceCharge?: number;
    convenienceChargeGst?: number;
    finalAmount?: number;
    currency?: string;
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    paymentStatus?: string;
    transactionDate?: Date;
  };
  isAdmin: boolean;
  migratedFromOldApp: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    mobile: { type: String, unique: true, sparse: true, trim: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    passwordHash: String,
    googleId: { type: String, unique: true, sparse: true, trim: true },
    firebaseUid: { type: String, unique: true, sparse: true, trim: true },
    appleId: { type: String, unique: true, sparse: true, trim: true },
    loginProvider: { type: String, enum: ["EMAIL", "GOOGLE", "APPLE"], default: "EMAIL", index: true },
    appleUserId: { type: String, unique: true, sparse: true, trim: true },
    appleEmail: { type: String, lowercase: true, trim: true },
    isAppleLogin: { type: Boolean, default: false, index: true },
    authTypes: { type: [String], default: [] },
    name: String,
    address: { type: String, default: "" },
    examMode: { type: String, trim: true },
    level: { type: String, trim: true },
    onboardingComplete: { type: Boolean, default: false },
    mobileVerified: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    requiresProfileCompletion: { type: Boolean, default: false },
    country: { type: String, default: "" },
    state: { type: String, default: "" },
    city: { type: String, default: "" },
    userType: { type: String, default: "" },
    profileImage: { type: String, default: "" },
    fcmTokens: { type: [String], default: [], select: false },
    fcmTokenLastUpdated: Date,
    isActive: { type: Boolean, default: true },
    isBlocked: { type: Boolean, default: false },
    lastLoginAt: Date,
    isPremium: { type: Boolean, default: false },
    premiumExpiresAt: Date,
    premiumPlan: String,
    premiumExpiry: Date,
    paymentPlatform: { type: String, enum: ["ios", "android", "web"] },
    lastPurchase: {
      subscriptionId: String,
      planId: String,
      planAmount: Number,
      discountAmount: Number,
      taxAmount: Number,
      convenienceCharge: Number,
      convenienceChargeGst: Number,
      finalAmount: Number,
      currency: String,
      razorpayOrderId: String,
      razorpayPaymentId: String,
      paymentStatus: String,
      transactionDate: Date,
    },
    isAdmin: { type: Boolean, default: false },
    migratedFromOldApp: { type: Boolean, default: false },
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

export const User = mongoose.models["User"] ?? mongoose.model<IUser>("User", UserSchema);
