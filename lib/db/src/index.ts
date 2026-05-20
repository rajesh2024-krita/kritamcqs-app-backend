import mongoose from "mongoose";

function uriHasDatabaseName(uri: string) {
  try {
    const parsed = new URL(uri);
    const databaseName = parsed.pathname.replace(/^\/+/, "").trim();
    return Boolean(databaseName);
  } catch {
    return /mongodb(?:\+srv)?:\/\/[^/]+\/[^?]+/.test(uri);
  }
}

export async function connect(): Promise<void> {
  const uri = process.env["MONGODB_URI"];
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is required. Please add your MongoDB connection string.");
  }

  const dbName = process.env["MONGODB_DB_NAME"] || (!uriHasDatabaseName(uri) ? "kritamcqs" : undefined);
  await mongoose.connect(uri, dbName ? { dbName } : undefined);
}

export { mongoose };
export * from "./models/User";
export * from "./models/Otp";
export * from "./models/AuthOtp";
export * from "./models/AuthSettings";
export * from "./models/Mode";
export * from "./models/LearningLevel";
export * from "./models/Difficulty";
export * from "./models/ExamType";
export * from "./models/Year";
export * from "./models/Subject";
export * from "./models/Chapter";
export * from "./models/Topic";
export * from "./models/Question";
export * from "./models/Test";
export * from "./models/MockTest";
export * from "./models/ChapterPerformance";
export * from "./models/Mistake";
export * from "./models/Subscription";
export * from "./models/SubscriptionPlan";
export * from "./models/PaymentGatewaySettings";
export * from "./models/Coupon";
export * from "./models/ExamFramework";
export * from "./models/QuestionType";
export * from "./models/DailyAssignment";
export * from "./models/DailyPlanConfig";
export * from "./models/LearningSession";
export * from "./models/SessionAttempt";
export * from "./models/QuestionAttempt";
export * from "./models/RevisionHistory";
export * from "./models/MistakeBook";
export * from "./models/Performance";
export * from "./models/DailyTest";
export * from "./models/DailyTestSettings";
export * from "./models/RevisionSettings";
export * from "./models/MigrationLog";
export * from "./models/InvoiceSettings";
export * from "./models/Invoice";
export * from "./models/ExamMarkingSettings";
export * from "./models/NotificationSettings";
export * from "./models/EmailTemplate";
export * from "./models/EmailLog";
export * from "./models/HelpDeskSettings";
export * from "./models/UserNotification";
export * from "./models/SupportTicket";
