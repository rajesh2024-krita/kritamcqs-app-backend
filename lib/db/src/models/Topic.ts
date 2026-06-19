import mongoose, { Schema, Document } from "mongoose";

export interface ITopic extends Document {
  id: string;
  subjectId: string;
  chapterId: string;
  name: string;
  normalizedName: string;
  createdAt: Date;
  updatedAt: Date;
}

const topicSchema = new Schema<ITopic>(
  {
    subjectId: { type: Schema.Types.ObjectId, ref: "Subject", required: true, index: true },
    chapterId: { type: Schema.Types.ObjectId, ref: "Chapter", required: true, index: true },
    name: { type: String, required: true, trim: true, index: true },
    normalizedName: { type: String, required: true, trim: true, index: true },
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

topicSchema.pre("validate", function normalizeTopicName(next) {
  const nextName = String(this.name || "").trim();
  this.name = nextName;
  this.normalizedName = nextName.toLowerCase();
  next();
});

topicSchema.index({ chapterId: 1, normalizedName: 1 }, { unique: true });
topicSchema.index({ subjectId: 1, chapterId: 1, normalizedName: 1 });

export const Topic = mongoose.models["Topic"] ?? mongoose.model<ITopic>("Topic", topicSchema);
