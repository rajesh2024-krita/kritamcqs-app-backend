import mongoose, { Schema, Document } from "mongoose";

export interface IHelpDeskSettings extends Document {
  key: string;
  mode: "database" | "email" | "both";
  adminEmail: string;
  autoReplyTemplateKey: string;
  ticketReceivedTemplateKey: string;
  ticketStatusTemplateKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const HelpDeskSettingsSchema = new Schema<IHelpDeskSettings>(
  {
    key: { type: String, default: "default", unique: true, index: true },
    mode: { type: String, enum: ["database", "email", "both"], default: "both" },
    adminEmail: { type: String, default: "" },
    autoReplyTemplateKey: { type: String, default: "helpdesk_auto_reply" },
    ticketReceivedTemplateKey: { type: String, default: "helpdesk_ticket_created" },
    ticketStatusTemplateKey: { type: String, default: "helpdesk_ticket_reply" },
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

export const HelpDeskSettings =
  mongoose.models["HelpDeskSettings"] ?? mongoose.model<IHelpDeskSettings>("HelpDeskSettings", HelpDeskSettingsSchema);
