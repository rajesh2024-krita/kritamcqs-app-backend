import mongoose, { Schema, Document } from "mongoose";

export interface INationalCompetitionReward extends Document {
  id: string;
  competitionId: string;
  title: string;
  description: string;
  rewardType: "cash" | "voucher" | "badge" | "certificate" | "other";
  rankFrom: number;
  rankTo: number;
  value: number;
  voucherCode?: string;
  approvalStatus: "draft" | "pending" | "approved" | "distributed" | "rejected";
  approvedBy?: string;
  distributedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const NationalCompetitionRewardSchema = new Schema<INationalCompetitionReward>(
  {
    competitionId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    rewardType: { type: String, enum: ["cash", "voucher", "badge", "certificate", "other"], default: "voucher" },
    rankFrom: { type: Number, default: 1, index: true },
    rankTo: { type: Number, default: 1, index: true },
    value: { type: Number, default: 0 },
    voucherCode: { type: String, default: "" },
    approvalStatus: { type: String, enum: ["draft", "pending", "approved", "distributed", "rejected"], default: "draft", index: true },
    approvedBy: { type: String, default: "" },
    distributedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: "NationalCompetitionRewards",
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

export const NationalCompetitionReward =
  mongoose.models["NationalCompetitionReward"] ??
  mongoose.model<INationalCompetitionReward>("NationalCompetitionReward", NationalCompetitionRewardSchema);
