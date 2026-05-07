import mongoose, { Schema, Document } from "mongoose";

export interface IMigrationLog extends Document {
  totalUsers: number;
  importedUsers: number;
  duplicateUsers: number;
  invalidUsers: number;
  migrationDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MigrationLogSchema = new Schema<IMigrationLog>(
  {
    totalUsers: { type: Number, required: true, default: 0 },
    importedUsers: { type: Number, required: true, default: 0 },
    duplicateUsers: { type: Number, required: true, default: 0 },
    invalidUsers: { type: Number, required: true, default: 0 },
    migrationDate: { type: Date, required: true, default: Date.now },
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
  }
);

export const MigrationLog =
  mongoose.models["MigrationLog"] ?? mongoose.model<IMigrationLog>("MigrationLog", MigrationLogSchema);
