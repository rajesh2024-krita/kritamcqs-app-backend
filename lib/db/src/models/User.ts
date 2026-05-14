import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  id: string;
  mobile: string;
  email?: string;
  passwordHash?: string;
  googleId?: string;
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
  isActive?: boolean;
  isBlocked?: boolean;
  lastLoginAt?: Date;
  isPremium: boolean;
  premiumExpiresAt?: Date;
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
    isActive: { type: Boolean, default: true },
    isBlocked: { type: Boolean, default: false },
    lastLoginAt: Date,
    isPremium: { type: Boolean, default: false },
    premiumExpiresAt: Date,
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
