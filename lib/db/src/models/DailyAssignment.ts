import mongoose, { Schema, Document } from "mongoose";

export interface IDailyAssignment extends Document {
  id: string;
  userId: string;
  dateKey: string;
  modeId: string;
  modeKey: "NEET" | "JEE" | "BOTH";
  questionIds: string[];
  assignedCount: number;
  completedQuestionIds: string[];
  completedCount: number;
  source: "daily_set";
  createdAt: Date;
  updatedAt: Date;
}

const DailyAssignmentSchema = new Schema<IDailyAssignment>(
  {
    userId: { type: String, required: true, index: true },
    dateKey: { type: String, required: true, index: true },
    modeId: { type: String, required: true },
    modeKey: { type: String, enum: ["NEET", "JEE", "BOTH"], required: true },
    questionIds: { type: [String], default: [] },
    assignedCount: { type: Number, default: 0 },
    completedQuestionIds: { type: [String], default: [] },
    completedCount: { type: Number, default: 0 },
    source: { type: String, enum: ["daily_set"], default: "daily_set" },
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
  },
);

DailyAssignmentSchema.index({ userId: 1, dateKey: 1 }, { unique: true });

export const DailyAssignment =
  mongoose.models["DailyAssignment"] ?? mongoose.model<IDailyAssignment>("DailyAssignment", DailyAssignmentSchema);
