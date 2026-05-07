import mongoose, { Document, Schema } from "mongoose";

export interface IDailyPlanConfig extends Document {
  id: string;
  modeKey: "NEET" | "JEE" | "BOTH";
  selectionMode: "random" | "manual";
  questionCount: number;
  manualQuestionIds: string[];
  autoFillRemaining: boolean;
  isActive: boolean;
  title?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DailyPlanConfigSchema = new Schema<IDailyPlanConfig>(
  {
    modeKey: { type: String, enum: ["NEET", "JEE", "BOTH"], required: true, unique: true, index: true },
    selectionMode: { type: String, enum: ["random", "manual"], default: "random", required: true },
    questionCount: { type: Number, default: 20, min: 1, max: 200 },
    manualQuestionIds: { type: [String], default: [] },
    autoFillRemaining: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
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

DailyPlanConfigSchema.index({ modeKey: 1 }, { unique: true });

export const DailyPlanConfig =
  mongoose.models["DailyPlanConfig"] ?? mongoose.model<IDailyPlanConfig>("DailyPlanConfig", DailyPlanConfigSchema);
