import mongoose, { Schema, Document } from "mongoose";

export interface ISupportTicket extends Document {
  id: string;
  ticketId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userMobile?: string;
  category: string;
  status: "open" | "pending" | "closed";
  isReadByAdmin: boolean;
  messages: Array<{
    sender: "user" | "admin";
    message: string;
    attachmentUrl?: string;
    attachmentName?: string;
    createdAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const supportMessageSchema = new Schema(
  {
    sender: { type: String, enum: ["user", "admin"], required: true },
    message: { type: String, required: true, trim: true },
    attachmentUrl: { type: String, default: "" },
    attachmentName: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, default: "" },
    userEmail: { type: String, default: "" },
    userMobile: { type: String, default: "" },
    category: { type: String, required: true, trim: true },
    status: { type: String, enum: ["open", "pending", "closed"], default: "open", index: true },
    isReadByAdmin: { type: Boolean, default: false, index: true },
    messages: { type: [supportMessageSchema], default: [] },
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

supportTicketSchema.index({ userId: 1, createdAt: -1 });
supportTicketSchema.index({ isReadByAdmin: 1, updatedAt: -1 });

export const SupportTicket = mongoose.models["SupportTicket"] ?? mongoose.model<ISupportTicket>("SupportTicket", supportTicketSchema);
