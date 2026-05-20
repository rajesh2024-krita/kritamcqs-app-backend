import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "kritamcqs";
const write = process.argv.includes("--write");

if (!uri) {
  console.error("MONGODB_URI is required. Add it to .env or export it before running this script.");
  process.exit(1);
}

function toExamType(question) {
  const value = String(question.examMode ?? question.examType ?? question.exam ?? "").toUpperCase();
  if (value.includes("JEE")) return "JEE";
  if (value.includes("NEET")) return "NEET";
  return "";
}

function readYearValue(...values) {
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    const exact = Number(raw);
    if (/^\d{4}$/.test(raw) && Number.isFinite(exact)) return exact;
    const match = raw.match(/\b(19|20)\d{2}\b/);
    if (match?.[0]) return Number(match[0]);
  }
  return undefined;
}

function keyFor(yearValue, examType) {
  return `${yearValue}:${examType || "ANY"}`;
}

async function main() {
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const questions = db.collection("questions");
  const years = db.collection("years");

  console.log(`Connected database: ${db.databaseName}`);
  console.log(write ? "Mode: WRITE" : "Mode: dry run. Re-run with --write to update question yearId values.");

  const yearDocs = await years.find({}).toArray();
  const yearMap = new Map();
  for (const year of yearDocs) {
    const yearValue = readYearValue(year.value, year.name, year.label);
    if (!yearValue) continue;
    const examType = String(year.examType ?? "").toUpperCase();
    yearMap.set(keyFor(yearValue, examType), String(year._id));
    if (!yearMap.has(keyFor(yearValue, "ANY"))) yearMap.set(keyFor(yearValue, "ANY"), String(year._id));
  }

  const candidates = await questions
    .aggregate([
      {
        $addFields: {
          yearObjectId: { $convert: { input: "$yearId", to: "objectId", onError: null, onNull: null } },
        },
      },
      {
        $lookup: {
          from: "years",
          localField: "yearObjectId",
          foreignField: "_id",
          as: "matchedYear",
        },
      },
      {
        $match: {
          $or: [
            { yearId: { $in: [null, ""] } },
            { yearId: { $exists: false } },
            { matchedYear: { $size: 0 } },
          ],
        },
      },
      {
        $project: {
          _id: 1,
          yearId: 1,
          year: 1,
          yearLabel: 1,
          examYear: 1,
          previousYear: 1,
          examMode: 1,
          examType: 1,
          exam: 1,
        },
      },
    ])
    .toArray();

  const updates = [];
  const unresolved = [];

  for (const question of candidates) {
    const yearValue = readYearValue(question.year, question.yearLabel, question.examYear, question.previousYear);
    const examType = toExamType(question);
    const replacementYearId =
      yearValue
        ? yearMap.get(keyFor(yearValue, examType)) ?? yearMap.get(keyFor(yearValue, "ANY"))
        : undefined;

    if (!replacementYearId) {
      unresolved.push({
        id: String(question._id),
        yearId: question.yearId,
        year: question.year,
        yearLabel: question.yearLabel,
        examYear: question.examYear,
        previousYear: question.previousYear,
        examType,
      });
      continue;
    }

    updates.push({
      updateOne: {
        filter: { _id: question._id },
        update: {
          $set: {
            yearId: replacementYearId,
            year: yearValue,
            yearLabel: String(yearValue),
          },
        },
      },
    });
  }

  console.log(`Stale/missing yearId candidates: ${candidates.length}`);
  console.log(`Repairable from stable year fields: ${updates.length}`);
  console.log(`Unresolved because no stable year value exists: ${unresolved.length}`);
  console.log("Unresolved sample:", JSON.stringify(unresolved.slice(0, 20), null, 2));

  if (write && updates.length) {
    const result = await questions.bulkWrite(updates, { ordered: false });
    console.log(`Updated questions: ${result.modifiedCount}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
