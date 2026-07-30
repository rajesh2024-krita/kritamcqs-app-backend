import mongoose, { Schema, Document } from "mongoose";

export interface INationalCompetitionAuditLog extends Document {
  id: string;
  competitionId?: string;
  actorId: string;
  actorRole: "student" | "admin" | "system";
  action: string;
  metadata: Record<string, unknown>;
  ipAddress: string;
  createdAt: Date;
  updatedAt: Date;
}

const NationalCompetitionAuditLogSchema = new Schema<INationalCompetitionAuditLog>(
  {
    competitionId: { type: String, default: "", index: true },
    actorId: { type: String, default: "", index: true },
    actorRole: { type: String, enum: ["student", "admin", "system"], default: "system" },
    action: { type: String, required: true, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: "" },
  },
  {
    timestamps: true,
    collection: "NationalCompetitionAuditLogs",
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

export const NationalCompetitionAuditLog =
  mongoose.models["NationalCompetitionAuditLog"] ??
  mongoose.model<INationalCompetitionAuditLog>("NationalCompetitionAuditLog", NationalCompetitionAuditLogSchema);
