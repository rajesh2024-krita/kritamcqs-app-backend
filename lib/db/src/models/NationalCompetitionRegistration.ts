import mongoose, { Schema, Document } from "mongoose";

export type CompetitionRegistrationStatus = "pending" | "approved" | "rejected" | "locked" | "cancelled";

export interface INationalCompetitionRegistration extends Document {
  id: string;
  competitionId: string;
  userId: string;
  status: CompetitionRegistrationStatus;
  state: string;
  district: string;
  school: string;
  deviceId: string;
  eligibilitySnapshot: Record<string, unknown>;
  approvedBy?: string;
  approvedAt?: Date;
  lockedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const NationalCompetitionRegistrationSchema = new Schema<INationalCompetitionRegistration>(
  {
    competitionId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    status: { type: String, enum: ["pending", "approved", "rejected", "locked", "cancelled"], default: "approved", index: true },
    state: { type: String, default: "", index: true },
    district: { type: String, default: "", index: true },
    school: { type: String, default: "" },
    deviceId: { type: String, default: "" },
    eligibilitySnapshot: { type: Schema.Types.Mixed, default: {} },
    approvedBy: { type: String, default: "" },
    approvedAt: { type: Date },
    lockedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: "NationalCompetitionRegistrations",
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

NationalCompetitionRegistrationSchema.index({ competitionId: 1, userId: 1 }, { unique: true });

export const NationalCompetitionRegistration =
  mongoose.models["NationalCompetitionRegistration"] ??
  mongoose.model<INationalCompetitionRegistration>("NationalCompetitionRegistration", NationalCompetitionRegistrationSchema);
