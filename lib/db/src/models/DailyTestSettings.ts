import mongoose, { Schema, Document } from "mongoose";

export interface IDailyTestSettings extends Document {
  id: string;
  totalQuestions: number;
  newQuestions: number;
  weakQuestions: number;
  revisionQuestions: number;
  easyPercentage: number;
  moderatePercentage: number;
  hardPercentage: number;
  enabled: boolean;
  adaptiveModeEnabled: boolean;
  repeatLookbackSessions: number;
  maxRepeatedQuestions: number;
  lowPerformanceRatio: {
    easy: number;
    moderate: number;
    hard: number;
  };
  mediumPerformanceRatio: {
    easy: number;
    moderate: number;
    hard: number;
  };
  highPerformanceRatio: {
    easy: number;
    moderate: number;
    hard: number;
  };
  mixedModeRatio: {
    easy: number;
    moderate: number;
    hard: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const DailyTestSettingsSchema = new Schema<IDailyTestSettings>(
  {
    totalQuestions: { type: Number, default: 20, min: 1, max: 200 },
    newQuestions: { type: Number, default: 10, min: 0, max: 200 },
    weakQuestions: { type: Number, default: 5, min: 0, max: 200 },
    revisionQuestions: { type: Number, default: 5, min: 0, max: 200 },
    easyPercentage: { type: Number, default: 30, min: 0, max: 100 },
    moderatePercentage: { type: Number, default: 40, min: 0, max: 100 },
    hardPercentage: { type: Number, default: 30, min: 0, max: 100 },
    enabled: { type: Boolean, default: true },
    adaptiveModeEnabled: { type: Boolean, default: true },
    repeatLookbackSessions: { type: Number, default: 5, min: 1, max: 30 },
    maxRepeatedQuestions: { type: Number, default: 2, min: 0, max: 200 },
    lowPerformanceRatio: {
      easy: { type: Number, default: 70, min: 0, max: 100 },
      moderate: { type: Number, default: 20, min: 0, max: 100 },
      hard: { type: Number, default: 10, min: 0, max: 100 },
    },
    mediumPerformanceRatio: {
      easy: { type: Number, default: 40, min: 0, max: 100 },
      moderate: { type: Number, default: 40, min: 0, max: 100 },
      hard: { type: Number, default: 20, min: 0, max: 100 },
    },
    highPerformanceRatio: {
      easy: { type: Number, default: 15, min: 0, max: 100 },
      moderate: { type: Number, default: 45, min: 0, max: 100 },
      hard: { type: Number, default: 40, min: 0, max: 100 },
    },
    mixedModeRatio: {
      easy: { type: Number, default: 34, min: 0, max: 100 },
      moderate: { type: Number, default: 33, min: 0, max: 100 },
      hard: { type: Number, default: 33, min: 0, max: 100 },
    },
  },
  {
    timestamps: true,
    collection: "DailyTestSettings",
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

DailyTestSettingsSchema.pre("validate", function validateDistribution(next) {
  const countTotal = Number(this.newQuestions || 0) + Number(this.weakQuestions || 0) + Number(this.revisionQuestions || 0);
  const percentageTotal = Number(this.easyPercentage || 0) + Number(this.moderatePercentage || 0) + Number(this.hardPercentage || 0);
  const adaptiveRatios = [
    this.lowPerformanceRatio,
    this.mediumPerformanceRatio,
    this.highPerformanceRatio,
    this.mixedModeRatio,
  ];

  if (countTotal !== Number(this.totalQuestions || 0)) {
    return next(new Error("New, weak, and revision counts must equal total questions"));
  }
  if (percentageTotal !== 100) {
    return next(new Error("Easy, moderate, and hard percentages must total 100"));
  }
  for (const ratio of adaptiveRatios) {
    const total = Number(ratio?.easy || 0) + Number(ratio?.moderate || 0) + Number(ratio?.hard || 0);
    if (total !== 100) {
      return next(new Error("Adaptive difficulty ratio groups must each total 100"));
    }
  }
  return next();
});

export const DailyTestSettings =
  mongoose.models["DailyTestSettings"] ?? mongoose.model<IDailyTestSettings>("DailyTestSettings", DailyTestSettingsSchema);
