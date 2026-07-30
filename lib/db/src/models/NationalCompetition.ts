import mongoose, { Schema, Document } from "mongoose";

export type CompetitionStatus = "draft" | "scheduled" | "registration_open" | "registration_closed" | "live" | "completed" | "archived" | "cancelled";

export interface INationalCompetition extends Document {
  id: string;
  title: string;
  slug: string;
  description: string;
  examType: "NEET" | "JEE" | "BOTH";
  status: CompetitionStatus;
  registrationOpensAt: Date;
  registrationClosesAt: Date;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  totalQuestions: number;
  marksPerQuestion: number;
  negativeMarks: number;
  questionIds: string[];
  questionSelection: {
    mode: "manual" | "automatic";
    filters: Record<string, unknown>;
    targetCount: number;
    lastGeneratedAt?: Date;
  };
  rules: string[];
  rewardsSummary: string;
  terms: string;
  eligibility: {
    premiumRequired: boolean;
    allowedStates: string[];
    allowedDistricts: string[];
    participantLimit: number;
    approvalRequired: boolean;
  };
  leaderboard: {
    enabled: boolean;
    refreshSeconds: number;
    rankingPriority: string[];
    rankingWeights: Record<string, number>;
    publishWeekly: boolean;
    publishMonthly: boolean;
  };
  security: {
    oneAttemptOnly: boolean;
    deviceValidation: boolean;
    duplicateLoginDetection: boolean;
    autosaveIntervalSeconds: number;
  };
  notificationEvents: string[];
  isActive: boolean;
  archivedAt?: Date;
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const NationalCompetitionSchema = new Schema<INationalCompetition>(
  {
    title: { type: String, required: true, trim: true, index: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, default: "" },
    examType: { type: String, enum: ["NEET", "JEE", "BOTH"], default: "BOTH", index: true },
    status: {
      type: String,
      enum: ["draft", "scheduled", "registration_open", "registration_closed", "live", "completed", "archived", "cancelled"],
      default: "draft",
      index: true,
    },
    registrationOpensAt: { type: Date, required: true, index: true },
    registrationClosesAt: { type: Date, required: true, index: true },
    startsAt: { type: Date, required: true, index: true },
    endsAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 180, min: 1 },
    totalQuestions: { type: Number, default: 180, min: 1 },
    marksPerQuestion: { type: Number, default: 4 },
    negativeMarks: { type: Number, default: 1 },
    questionIds: { type: [String], default: [] },
    questionSelection: {
      mode: { type: String, enum: ["manual", "automatic"], default: "manual" },
      filters: { type: Schema.Types.Mixed, default: {} },
      targetCount: { type: Number, default: 0 },
      lastGeneratedAt: { type: Date },
    },
    rules: { type: [String], default: [] },
    rewardsSummary: { type: String, default: "" },
    terms: { type: String, default: "" },
    eligibility: {
      premiumRequired: { type: Boolean, default: false },
      allowedStates: { type: [String], default: [] },
      allowedDistricts: { type: [String], default: [] },
      participantLimit: { type: Number, default: 0 },
      approvalRequired: { type: Boolean, default: false },
    },
    leaderboard: {
      enabled: { type: Boolean, default: true },
      refreshSeconds: { type: Number, default: 30, min: 5 },
      rankingPriority: {
        type: [String],
        default: ["marks", "negativeMarks", "totalTime", "averageTimePerQuestion", "accuracy", "submissionTime", "attendance"],
      },
      rankingWeights: { type: Map, of: Number, default: {} },
      publishWeekly: { type: Boolean, default: true },
      publishMonthly: { type: Boolean, default: true },
    },
    security: {
      oneAttemptOnly: { type: Boolean, default: true },
      deviceValidation: { type: Boolean, default: true },
      duplicateLoginDetection: { type: Boolean, default: true },
      autosaveIntervalSeconds: { type: Number, default: 20, min: 5 },
    },
    notificationEvents: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    archivedAt: { type: Date },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  {
    timestamps: true,
    collection: "NationalCompetitions",
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

NationalCompetitionSchema.index({ status: 1, startsAt: 1 });
NationalCompetitionSchema.index({ examType: 1, isActive: 1, startsAt: 1 });

export const NationalCompetition =
  mongoose.models["NationalCompetition"] ?? mongoose.model<INationalCompetition>("NationalCompetition", NationalCompetitionSchema);
