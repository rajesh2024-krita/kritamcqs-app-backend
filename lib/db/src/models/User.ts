import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  id: string;
  mobile: string;
  email?: string;
  passwordHash?: string;
  name?: string;
  examMode?: "NEET" | "JEE" | "BOTH";
  level?: "Beginner" | "Average" | "Topper";
  onboardingComplete: boolean;
  mobileVerified: boolean;
  isPremium: boolean;
  premiumExpiresAt?: Date;
  isAdmin: boolean;
  migratedFromOldApp: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    mobile: { type: String, required: true, unique: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    passwordHash: String,
    name: String,
    examMode: { type: String, enum: ["NEET", "JEE", "BOTH"] },
    level: { type: String, enum: ["Beginner", "Average", "Topper"] },
    onboardingComplete: { type: Boolean, default: false },
    mobileVerified: { type: Boolean, default: false },
    isPremium: { type: Boolean, default: false },
    premiumExpiresAt: Date,
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
