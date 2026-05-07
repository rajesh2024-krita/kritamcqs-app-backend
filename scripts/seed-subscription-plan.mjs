import "dotenv/config";
import mongoose from "mongoose";

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  throw new Error("MONGODB_URI is required to seed the subscription plan.");
}

const subscriptionPlanSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    durationMonths: { type: Number, required: true, min: 1 },
    savings: { type: String, trim: true },
    features: [{ type: String, trim: true }],
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 1 },
  },
  { timestamps: true },
);

const SubscriptionPlan = mongoose.models.SubscriptionPlan || mongoose.model("SubscriptionPlan", subscriptionPlanSchema);

const subscriptionPlan = {
  planId: "premium_6m",
  name: "Premium 6 Months",
  price: 499,
  durationMonths: 6,
  savings: "Save 50% vs monthly",
  features: [
    "Unlimited smart tests",
    "Full question bank access",
    "Advanced weak area analytics",
    "Detailed performance reports",
    "Priority revision engine",
    "All subjects & chapters",
    "Ad-free experience",
    "Expert explanations",
  ],
  active: true,
  sortOrder: 1,
};

async function run() {
  await mongoose.connect(mongoUri);

  await SubscriptionPlan.updateOne(
    { planId: subscriptionPlan.planId },
    { $set: subscriptionPlan },
    { upsert: true },
  );

  console.log(`Subscription plan '${subscriptionPlan.planId}' upserted successfully.`);
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("Failed to seed subscription plan", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
