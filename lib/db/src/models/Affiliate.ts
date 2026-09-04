import mongoose, { Schema, type Document } from "mongoose";

export interface IAffiliate extends Document {
  firstName: string; lastName?: string; affiliateName: string; email: string; mobile?: string; username: string;
  passwordHash: string; profileImage?: string; affiliateCode: string; referralLink: string; status: "ACTIVE" | "INACTIVE" | "SUSPENDED" | "DELETED";
  accessEnabled?: boolean; tokenVersion?: number; roleId?: mongoose.Types.ObjectId; permissionOverrides?: Record<string, boolean>; referralTarget?: number; commissionRatePercent?: number;
  company?: string; organization?: string; profession?: string; website?: string; socialMediaLinks?: Record<string, string>;
  address?: string; city?: string; state?: string; country?: string; pincode?: string; description?: string;
  accountHolderName?: string; bankName?: string; accountNumber?: string; ifsc?: string; upiId?: string; pan?: string; gst?: string;
  profileCompletion: number; notes?: string; lastLoginAt?: Date;
}

const commonOptions = { timestamps: true, toJSON: { virtuals: true, transform: (_d: unknown, ret: any) => { ret.id = ret._id?.toString(); delete ret._id; delete ret.__v; delete ret.passwordHash; delete ret.accountNumber; } } };

const AffiliateSchema = new Schema<IAffiliate>({
  firstName: { type: String, required: true, trim: true }, lastName: { type: String, trim: true }, affiliateName: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true }, mobile: { type: String, trim: true }, username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false }, profileImage: String, affiliateCode: { type: String, required: true, unique: true, uppercase: true, trim: true, match: /^[A-Z0-9_-]{4,24}$/ },
  referralLink: { type: String, required: true }, status: { type: String, enum: ["ACTIVE", "INACTIVE", "SUSPENDED", "DELETED"], default: "ACTIVE", index: true }, accessEnabled: { type: Boolean, default: true }, tokenVersion: { type: Number, default: 0, select: false }, roleId: { type: Schema.Types.ObjectId, ref: "AffiliateRole" }, permissionOverrides: { type: Map, of: Boolean, default: {} }, referralTarget: Number, commissionRatePercent: Number,
  company: String, organization: String, profession: String, website: String, socialMediaLinks: { type: Schema.Types.Mixed, default: {} }, address: String, city: String, state: String, country: String, pincode: String, description: String,
  accountHolderName: String, bankName: String, accountNumber: { type: String, select: false }, ifsc: String, upiId: String, pan: String, gst: String,
  profileCompletion: { type: Number, default: 0, min: 0, max: 100 }, notes: String, lastLoginAt: Date,
}, commonOptions);

const AffiliateReferralSchema = new Schema({
  affiliateId: { type: Schema.Types.ObjectId, ref: "Affiliate", required: true, index: true }, referralClickId: { type: String, required: true, unique: true, index: true }, affiliateCode: { type: String, required: true, index: true },
  userId: { type: String, index: true }, campaign: { type: String, trim: true, index: true }, affiliateLinkId: { type: String, trim: true, index: true }, referralUrl: String, platform: { type: String, enum: ["WEB", "ANDROID", "IOS"], required: true, index: true }, deviceType: String, browser: String, osName: String, osVersion: String, appVersion: String,
  ipAddress: String, userAgent: String, clickStatus: { type: String, enum: ["CLICKED", "DUPLICATE", "EXPIRED"], default: "CLICKED", index: true }, installationStatus: { type: String, enum: ["UNKNOWN", "NEW_INSTALL", "EXISTING_APP_USER"], default: "UNKNOWN", index: true },
  registrationStatus: { type: String, enum: ["PENDING", "REGISTERED", "EXISTING_USER", "NOT_REGISTERED"], default: "PENDING", index: true }, loginStatus: { type: String, enum: ["PENDING", "LOGGED_IN", "NOT_LOGGED_IN"], default: "PENDING", index: true },
  purchaseStatus: { type: String, enum: ["PENDING", "PAID", "FAILED", "CANCELLED", "REFUNDED"], default: "PENDING", index: true }, conversionStatus: { type: String, enum: ["PENDING", "SUCCESSFUL", "FAILED", "CANCELLED", "DUPLICATE", "REFUNDED"], default: "PENDING", index: true },
  userType: { type: String, enum: ["UNKNOWN", "NEW_USER", "EXISTING_USER"], default: "UNKNOWN", index: true }, attributionStatus: { type: String, enum: ["ACTIVE", "ATTRIBUTED", "EXPIRED", "REPLACED"], default: "ACTIVE", index: true },
  clickAt: { type: Date, default: Date.now, index: true }, expiresAt: { type: Date, index: true }, attributedAt: Date, registrationAt: { type: Date, index: true }, loginAt: Date, firstAppOpenAt: Date, purchaseAt: Date, subscriptionPlanId: String, purchaseAmount: Number,
  transactionId: { type: String, index: true }, paymentGateway: String, paymentStatus: String, subscriptionStatus: String, commissionRate: Number, commissionAmount: Number,
}, commonOptions);
AffiliateReferralSchema.index({ affiliateId: 1, clickAt: -1 });
AffiliateReferralSchema.index({ userId: 1, attributionStatus: 1, clickAt: -1 });

const AffiliatePurchaseSchema = new Schema({
  affiliateId: { type: Schema.Types.ObjectId, ref: "Affiliate", required: true, index: true }, userId: { type: String, required: true, index: true }, referralId: { type: Schema.Types.ObjectId, ref: "AffiliateReferral", required: true },
  subscriptionId: { type: String, required: true, index: true }, planId: { type: String, required: true, index: true }, platform: { type: String, enum: ["WEB", "ANDROID", "IOS"], required: true, index: true },
  transactionId: { type: String, required: true, unique: true, index: true }, paymentGateway: String, amount: { type: Number, required: true }, paymentStatus: { type: String, required: true, index: true }, subscriptionStatus: { type: String, required: true, index: true },
  conversionStatus: { type: String, enum: ["PENDING", "SUCCESSFUL", "FAILED", "CANCELLED", "DUPLICATE", "REFUNDED"], default: "SUCCESSFUL", index: true }, commissionRate: Number, commissionAmount: Number, purchaseAt: { type: Date, required: true, index: true }, refundedAt: Date,
}, commonOptions);
AffiliatePurchaseSchema.index({ affiliateId: 1, purchaseAt: -1 });

const AffiliateMilestoneSchema = new Schema({ affiliateId: { type: Schema.Types.ObjectId, ref: "Affiliate", required: true, index: true }, milestoneCount: { type: Number, required: true }, reachedAt: { type: Date, default: Date.now }, emailStatus: String, notificationStatus: String }, commonOptions);
AffiliateMilestoneSchema.index({ affiliateId: 1, milestoneCount: 1 }, { unique: true });
const AffiliateNotificationSchema = new Schema({ affiliateId: { type: Schema.Types.ObjectId, ref: "Affiliate", required: true, index: true }, notificationType: { type: String, required: true }, title: String, message: String, reportData: Schema.Types.Mixed, emailStatus: String, appNotificationStatus: String, readAt: Date }, commonOptions);
const AffiliateAuditLogSchema = new Schema({ adminId: { type: String, index: true }, affiliateId: { type: Schema.Types.ObjectId, ref: "Affiliate", index: true }, action: { type: String, required: true, index: true }, oldData: Schema.Types.Mixed, newData: Schema.Types.Mixed }, commonOptions);
const AffiliateSettingsSchema = new Schema({ key: { type: String, default: "default", unique: true }, attributionWindowDays: { type: Number, default: 30, min: 1, max: 365 }, attributionModel: { type: String, enum: ["FIRST_CLICK", "LAST_CLICK"], default: "LAST_CLICK" }, allowExistingUserAttribution: { type: Boolean, default: true }, commissionRatePercent: { type: Number, default: 20, min: 0, max: 100 }, milestoneCount: { type: Number, default: 10, min: 1 }, repeatMilestone: { type: Boolean, default: true }, emailEnabled: { type: Boolean, default: true }, appNotificationEnabled: { type: Boolean, default: true }, adminEmail: String, referralBaseUrl: { type: String, default: "https://app.kritamcqs.com/affiliate" } }, commonOptions);
const AffiliateEventTemplateSchema = new Schema({ event: { type: String, required: true, unique: true }, name: String, recipient: String, notificationEnabled: Boolean, emailEnabled: Boolean, title: String, message: String, subject: String, htmlContent: String, textContent: String, variables: [String] }, commonOptions);
const AffiliateActivityLogSchema = new Schema({ activityId: { type: String, unique: true }, userType: String, userId: String, affiliateId: { type: Schema.Types.ObjectId, ref: "Affiliate", index: true }, action: String, module: String, description: String, ipAddress: String, device: String, browser: String, metadata: Schema.Types.Mixed }, commonOptions);

export const Affiliate = mongoose.models["Affiliate"] ?? mongoose.model<IAffiliate>("Affiliate", AffiliateSchema);
export const AffiliateReferral = mongoose.models["AffiliateReferral"] ?? mongoose.model("AffiliateReferral", AffiliateReferralSchema);
export const AffiliatePurchase = mongoose.models["AffiliatePurchase"] ?? mongoose.model("AffiliatePurchase", AffiliatePurchaseSchema);
export const AffiliateMilestone = mongoose.models["AffiliateMilestone"] ?? mongoose.model("AffiliateMilestone", AffiliateMilestoneSchema);
export const AffiliateNotification = mongoose.models["AffiliateNotification"] ?? mongoose.model("AffiliateNotification", AffiliateNotificationSchema);
export const AffiliateAuditLog = mongoose.models["AffiliateAuditLog"] ?? mongoose.model("AffiliateAuditLog", AffiliateAuditLogSchema);
export const AffiliateSettings = mongoose.models["AffiliateSettings"] ?? mongoose.model("AffiliateSettings", AffiliateSettingsSchema);
export const AffiliateEventTemplate = mongoose.models["AffiliateEventTemplate"] ?? mongoose.model("AffiliateEventTemplate", AffiliateEventTemplateSchema);
export const AffiliateActivityLog = mongoose.models["AffiliateActivityLog"] ?? mongoose.model("AffiliateActivityLog", AffiliateActivityLogSchema);
