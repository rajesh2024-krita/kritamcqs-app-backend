import "dotenv/config";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI;
const write = process.argv.includes("--write");

if (!uri) {
  console.error("MONGODB_URI is required. Add it to .env or export it before running this script.");
  process.exit(1);
}

function examTypeFromQuestion(question) {
  const mode = String(question.examMode ?? question.exam ?? "").toUpperCase();
  if (mode.includes("JEE")) return "JEE";
  if (mode.includes("NEET")) return "NEET";
  return undefined;
}

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const questions = db.collection("questions");
  const years = db.collection("years");

  console.log(`Connected database: ${db.databaseName}`);
  console.log(write ? "Mode: WRITE" : "Mode: dry run. Re-run with --write to update local data.");

  const numericStringYears = await questions
    .find({ year: { $type: "string", $regex: /^\d{4}$/ } }, { projection: { _id: 1, year: 1 } })
    .toArray();
  console.log(`questions.year string values that can become numbers: ${numericStringYears.length}`);

  if (write && numericStringYears.length > 0) {
    const bulkYearUpdates = numericStringYears.map((question) => ({
      updateOne: {
        filter: { _id: question._id },
        update: { $set: { year: Number(question.year) } },
      },
    }));
    const result = await questions.bulkWrite(bulkYearUpdates, { ordered: false });
    console.log(`Converted question year strings: ${result.modifiedCount}`);
  }

  const distinctYears = await questions
    .aggregate([
      { $match: { year: { $nin: [null, ""] } } },
      {
        $project: {
          yearValue: { $convert: { input: "$year", to: "int", onError: null, onNull: null } },
          examType: { $ifNull: ["$examMode", "$exam"] },
        },
      },
      { $match: { yearValue: { $ne: null } } },
      { $group: { _id: { yearValue: "$yearValue", examType: "$examType" } } },
      { $sort: { "_id.yearValue": -1 } },
    ])
    .toArray();

  const yearInputs = distinctYears
    .map((item) => ({
      value: Number(item._id.yearValue),
      examType: String(item._id.examType ?? "").toUpperCase().includes("JEE") ? "JEE" : "NEET",
    }))
    .filter((item) => Number.isFinite(item.value));

  console.log(`Year records needed from question data: ${yearInputs.length}`);

  if (write) {
    for (const item of yearInputs) {
      const name = String(item.value);
      await years.updateOne(
        { name, examType: item.examType },
        { $set: { name, label: name, value: item.value, examType: item.examType } },
        { upsert: true },
      );
    }
    console.log("Ensured year records for question years.");
  }

  const unmappedQuestions = await questions
    .find(
      {
        year: { $nin: [null, ""] },
        $or: [{ yearId: { $exists: false } }, { yearId: null }, { yearId: "" }],
      },
      { projection: { _id: 1, year: 1, examMode: 1, exam: 1 } },
    )
    .toArray();
  console.log(`Questions with year but missing yearId: ${unmappedQuestions.length}`);

  if (write && unmappedQuestions.length > 0) {
    const yearDocs = await years.find({}, { projection: { _id: 1, name: 1, value: 1, examType: 1 } }).toArray();
    const yearMap = new Map(
      yearDocs.map((year) => [`${Number(year.value ?? year.name)}:${year.examType ?? "NEET"}`, String(year._id)]),
    );

    const bulkRefUpdates = [];
    for (const question of unmappedQuestions) {
      const yearValue = Number(question.year);
      const examType = examTypeFromQuestion(question) ?? "NEET";
      const yearId = yearMap.get(`${yearValue}:${examType}`) ?? yearMap.get(`${yearValue}:NEET`);
      if (yearId) {
        bulkRefUpdates.push({
          updateOne: {
            filter: { _id: question._id },
            update: { $set: { yearId } },
          },
        });
      }
    }

    if (bulkRefUpdates.length > 0) {
      const result = await questions.bulkWrite(bulkRefUpdates, { ordered: false });
      console.log(`Mapped missing question yearId values: ${result.modifiedCount}`);
    }
  }

  if (write) {
    await questions.createIndex({ year: 1 });
    await questions.createIndex({ examMode: 1 });
    await questions.createIndex({ exam: 1 });
    await questions.createIndex({ subject: 1 });
    await questions.createIndex({ yearId: 1 });
    await years.createIndex({ name: 1, examType: 1 }, { unique: true });
    await years.createIndex({ value: 1, examType: 1 });
    console.log("Ensured PYQ indexes.");
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
