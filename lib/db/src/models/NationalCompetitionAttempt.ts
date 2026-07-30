import mongoose, { Schema, Document } from "mongoose";

export type CompetitionAttemptStatus = "not_started" | "in_progress" | "submitted" | "auto_submitted" | "disqualified";

export interface INationalCompetitionAttempt extends Document {
  id: string;
  competitionId: string;
  registrationId: string;
  userId: string;
  status: CompetitionAttemptStatus;
  answers: Array<{ questionId: string; selectedOption?: string; selectedOptions?: string[]; numericAnswer?: string; savedAt: Date; timeSpentSeconds: number }>;
  score: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  negativeMarksApplied: number;
  totalTimeSeconds: number;
  averageTimePerQuestion: number;
  accuracy: number;
  startedAt?: Date;
  submittedAt?: Date;
  autoSubmittedAt?: Date;
  lastAutosavedAt?: Date;
  deviceId: string;
  ipAddress: string;
  suspiciousFlags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const NationalCompetitionAttemptSchema = new Schema<INationalCompetitionAttempt>(
  {
    competitionId: { type: String, required: true, index: true },
    registrationId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["not_started", "in_progress", "submitted", "auto_submitted", "disqualified"],
      default: "not_started",
      index: true,
    },
    answers: {
      type: [
        {
          questionId: { type: String, required: true },
          selectedOption: { type: String, default: "" },
          selectedOptions: { type: [String], default: [] },
          numericAnswer: { type: String, default: "" },
          savedAt: { type: Date, default: Date.now },
          timeSpentSeconds: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    score: { type: Number, default: 0, index: true },
    correctCount: { type: Number, default: 0 },
    wrongCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    negativeMarksApplied: { type: Number, default: 0 },
    totalTimeSeconds: { type: Number, default: 0 },
    averageTimePerQuestion: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
    startedAt: { type: Date },
    submittedAt: { type: Date, index: true },
    autoSubmittedAt: { type: Date },
    lastAutosavedAt: { type: Date },
    deviceId: { type: String, default: "" },
    ipAddress: { type: String, default: "" },
    suspiciousFlags: { type: [String], default: [] },
  },
  {
    timestamps: true,
    collection: "NationalCompetitionAttempts",
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

NationalCompetitionAttemptSchema.index({ competitionId: 1, userId: 1 }, { unique: true });

export const NationalCompetitionAttempt =
  mongoose.models["NationalCompetitionAttempt"] ??
  mongoose.model<INationalCompetitionAttempt>("NationalCompetitionAttempt", NationalCompetitionAttemptSchema);
