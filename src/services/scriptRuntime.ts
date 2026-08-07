import mongoose from "mongoose";

function collection(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  return db.collection(name);
}

function platformFrom(value: unknown): "Android" | "iOS" | "Web" {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "ios") return "iOS";
  if (normalized === "web") return "Web";
  return "Android";
}

export async function listEnabledScripts(platformInput: unknown) {
  const platform = platformFrom(platformInput);
  const items = await collection("third_party_scripts")
    .find({ status: "enabled", platform: { $in: [platform, "All"] } })
    .sort({ priority: 1, updatedAt: -1 })
    .toArray();
  return items.map((item) => ({ ...item, id: String(item._id), _id: undefined }));
}
