import mongoose, { Schema, Document } from "mongoose";

export interface INationalLeaderboardEntry extends Document {
  id: string;
  competitionId: string;
  attemptId: string;
  userId: string;
  userName: string;
  state: string;
  district: string;
  school: string;
  scope: "national" | "state" | "district" | "weekly" | "monthly" | "archived";
  periodKey: string;
  rank: number;
  score: number;
  negativeMarksApplied: number;
  totalTimeSeconds: number;
  averageTimePerQuestion: number;
  accuracy: number;
  submittedAt?: Date;
  attendanceScore: number;
  tieBreakSnapshot: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const NationalLeaderboardEntrySchema = new Schema<INationalLeaderboardEntry>(
  {
    competitionId: { type: String, required: true, index: true },
    attemptId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, default: "Learner" },
    state: { type: String, default: "", index: true },
    district: { type: String, default: "", index: true },
    school: { type: String, default: "" },
    scope: { type: String, enum: ["national", "state", "district", "weekly", "monthly", "archived"], default: "national", index: true },
    periodKey: { type: String, default: "", index: true },
    rank: { type: Number, default: 0, index: true },
    score: { type: Number, default: 0 },
    negativeMarksApplied: { type: Number, default: 0 },
    totalTimeSeconds: { type: Number, default: 0 },
    averageTimePerQuestion: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
    submittedAt: { type: Date },
    attendanceScore: { type: Number, default: 1 },
    tieBreakSnapshot: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: "NationalLeaderboardEntries",
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

NationalLeaderboardEntrySchema.index({ competitionId: 1, scope: 1, periodKey: 1, rank: 1 });
NationalLeaderboardEntrySchema.index({ competitionId: 1, scope: 1, userId: 1 });

export const NationalLeaderboardEntry =
  mongoose.models["NationalLeaderboardEntry"] ??
  mongoose.model<INationalLeaderboardEntry>("NationalLeaderboardEntry", NationalLeaderboardEntrySchema);
