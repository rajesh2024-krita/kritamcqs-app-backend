import mongoose, { Schema, Document } from "mongoose";

export interface IMockTest extends Document {
  id: string;
  title: string;
  slug: string;
  description?: string;
  examType: "NEET" | "JEE" | "BOTH";
  patternPreset: "NEET_REAL" | "JEE_REAL" | "CUSTOM";
  durationMinutes: number;
  totalQuestions: number;
  maxScore: number;
  questionIds: string[];
  subjectIds: string[];
  chapterIds: string[];
  instructions: string[];
  marksPerQuestion: number;
  negativeMarks: number;
  markingSchemeVersion?: string;
  markingScheme?: Record<string, unknown>;
  questionMarkingRules: Array<Record<string, unknown>>;
  markingOverrideEnabled: boolean;
  predictionTitle?: string;
  predictionDescription?: string;
  availabilityMode: "all" | "day_wise" | "week_wise";
  availableDaysOfMonth: number[];
  availableWeekdays: string[];
  totalAttemptQuestions?: number;
  sectionGroups: Array<Record<string, unknown>>;
  generationSource: "manual" | "auto";
  generationConfig?: Record<string, unknown>;
  generationHistory: Array<Record<string, unknown>>;
  randomizeQuestionOrder: boolean;
  isPremiumOnly: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MockTestSchema = new Schema<IMockTest>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true, index: true },
    description: String,
    examType: { type: String, enum: ["NEET", "JEE", "BOTH"], required: true, index: true },
    patternPreset: { type: String, enum: ["NEET_REAL", "JEE_REAL", "CUSTOM"], default: "CUSTOM", index: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    totalQuestions: { type: Number, required: true, min: 1 },
    maxScore: { type: Number, required: true, min: 1 },
    questionIds: { type: [String], default: [] },
    subjectIds: { type: [String], default: [] },
    chapterIds: { type: [String], default: [] },
    instructions: { type: [String], default: [] },
    marksPerQuestion: { type: Number, default: 4 },
    negativeMarks: { type: Number, default: 1 },
    markingSchemeVersion: { type: String, default: "v1" },
    markingScheme: { type: Schema.Types.Mixed },
    questionMarkingRules: { type: [Schema.Types.Mixed], default: [] },
    markingOverrideEnabled: { type: Boolean, default: false },
    predictionTitle: String,
    predictionDescription: String,
    availabilityMode: { type: String, enum: ["all", "day_wise", "week_wise"], default: "all" },
    availableDaysOfMonth: { type: [Number], default: [] },
    availableWeekdays: { type: [String], default: [] },
    totalAttemptQuestions: { type: Number, min: 1 },
    sectionGroups: { type: [Schema.Types.Mixed], default: [] },
    generationSource: { type: String, enum: ["manual", "auto"], default: "manual", index: true },
    generationConfig: { type: Schema.Types.Mixed },
    generationHistory: { type: [Schema.Types.Mixed], default: [] },
    randomizeQuestionOrder: { type: Boolean, default: true },
    isPremiumOnly: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true, index: true },
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

MockTestSchema.index({ examType: 1, isActive: 1, createdAt: -1 });

export const MockTest =
  mongoose.models["MockTest"] ?? mongoose.model<IMockTest>("MockTest", MockTestSchema);
