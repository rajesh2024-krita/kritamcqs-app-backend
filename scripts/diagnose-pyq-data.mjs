import "dotenv/config";
import mongoose from "mongoose";

const collections = ["questions", "exams", "previousyearpapers", "subjects", "chapters", "years"];
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("MONGODB_URI is required. Add it to .env or export it before running this script.");
  process.exit(1);
}

function print(title, value) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log(`Connected database: ${db.databaseName}`);

  const collectionStats = {};
  for (const name of collections) {
    const exists = await db.listCollections({ name }).hasNext();
    collectionStats[name] = exists ? await db.collection(name).countDocuments() : "missing";
  }
  print("Collection counts", collectionStats);

  const questions = db.collection("questions");
  const years = db.collection("years");

  const yearTypes = await questions
    .aggregate([
      { $project: { type: { $type: "$year" }, year: "$year" } },
      { $group: { _id: "$type", count: { $sum: 1 }, sample: { $first: "$year" } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  print("questions.year datatype distribution", yearTypes);

  const yearValues = await questions
    .aggregate([
      { $match: { year: { $nin: [null, ""] } } },
      { $group: { _id: "$year", type: { $first: { $type: "$year" } }, count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 50 },
    ])
    .toArray();
  print("Top question years", yearValues);

  const missingYear = await questions.countDocuments({
    $or: [{ year: { $exists: false } }, { year: null }, { year: "" }],
  });
  const missingYearId = await questions.countDocuments({
    $or: [{ yearId: { $exists: false } }, { yearId: null }, { yearId: "" }],
  });
  print("Missing year fields", { missingYear, missingYearId });

  const yearDocs = await years
    .find({}, { projection: { name: 1, label: 1, value: 1, examType: 1 } })
    .sort({ name: -1, value: -1 })
    .limit(100)
    .toArray();
  print("Year records", yearDocs);

  const invalidYearRefs = await questions
    .aggregate([
      { $match: { yearId: { $nin: [null, ""] } } },
      { $addFields: { yearObjectId: { $convert: { input: "$yearId", to: "objectId", onError: null, onNull: null } } } },
      { $lookup: { from: "years", localField: "yearObjectId", foreignField: "_id", as: "yearDoc" } },
      { $match: { yearDoc: { $size: 0 } } },
      { $group: { _id: "$yearId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 25 },
    ])
    .toArray();
  print("Question yearId values with no matching years record", invalidYearRefs);

  const questionIndexes = await questions.indexes().catch((error) => ({ error: error.message }));
  print("questions indexes", questionIndexes);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
