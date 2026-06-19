import { Router, type IRouter } from "express";
import { Question, mongoose } from "@api/db";
import { requireAuth } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";

const router: IRouter = Router();

function bytesToHex(bytes: ArrayLike<number>) {
  return Array.from(bytes, (byte) => Number(byte).toString(16).padStart(2, "0")).join("");
}

function toIdString(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();

  if (Buffer.isBuffer(value)) {
    return bytesToHex(value);
  }

  if (value && typeof value === "object") {
    const objectValue = value as any;

    if (typeof objectValue.toHexString === "function") {
      return String(objectValue.toHexString()).trim();
    }

    if (typeof objectValue.$oid === "string") {
      return String(objectValue.$oid).trim();
    }

    if (objectValue.type === "Buffer" && Array.isArray(objectValue.data)) {
      return bytesToHex(objectValue.data);
    }

    if (objectValue._bsontype === "Binary" && objectValue.buffer) {
      return bytesToHex(objectValue.buffer);
    }

    const nestedId = objectValue.id ?? objectValue._id;
    if (nestedId !== undefined) {
      return toIdString(nestedId);
    }

    return String(objectValue).trim();
  }

  return String(value).trim();
}

function buildIdVariants(id: string) {
  const stringId = String(id || "").trim();
  if (!stringId) return [];
  const variants: Array<string | mongoose.Types.ObjectId> = [stringId];
  if (mongoose.isValidObjectId(stringId)) {
    variants.push(new mongoose.Types.ObjectId(stringId));
  }
  return variants;
}

router.get("/:chapterId/topics", requireAuth, requireOnboardingComplete, async (req, res) => {
  const chapterId = String(req.params["chapterId"] || "").trim();
  if (!chapterId) {
    res.status(400).json({ error: "invalid_chapter", message: "Chapter id is required" });
    return;
  }

  const chapterVariants = buildIdVariants(chapterId);

  const questionTopicCounts = await Question.aggregate([
    {
      $match: {
        chapterId: { $in: chapterVariants },
        topicId: { $exists: true, $nin: [null, ""] },
      },
    },
    {
      $group: {
        _id: "$topicId",
        questionsCount: { $sum: 1 },
        subjectId: { $first: "$subjectId" },
        chapterId: { $first: "$chapterId" },
      },
    },
  ]);

  const topicIdsFromQuestions = [
    ...new Set(
      questionTopicCounts
        .map((item) => toIdString(item?._id))
        .filter(Boolean),
    ),
  ];

  const topicCollection = mongoose.connection.collection("topics");

  const chapterTopicDocs = await topicCollection
    .find({
      chapterId: { $in: chapterVariants },
    })
    .toArray();

  const topicIdObjectIds = topicIdsFromQuestions
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const topicDocsById = topicIdsFromQuestions.length
    ? await topicCollection
        .find({
          $or: [
            { _id: { $in: topicIdObjectIds } },
            { id: { $in: topicIdsFromQuestions } },
          ],
        })
        .toArray()
    : [];

  const topicDocs = [...chapterTopicDocs, ...topicDocsById];

  const countByTopicId = new Map<string, number>();
  const chapterByTopicId = new Map<string, string>();
  const subjectByTopicId = new Map<string, string>();
  questionTopicCounts.forEach((item) => {
    const topicId = toIdString(item?._id);
    if (!topicId) return;
    countByTopicId.set(topicId, Number(item?.questionsCount ?? 0));
    chapterByTopicId.set(topicId, toIdString(item?.chapterId));
    subjectByTopicId.set(topicId, toIdString(item?.subjectId));
  });

  const outputByTopicId = new Map<
    string,
    { id: string; name: string; subjectId: string; chapterId: string; questionsCount: number }
  >();

  topicDocs.forEach((doc: any) => {
    const id = toIdString(doc?.id ?? doc?._id);
    if (!id) return;

    const name = String(doc?.name ?? doc?.label ?? "").trim();
    outputByTopicId.set(id, {
      id,
      name: name || `Topic ${id.slice(-6)}`,
      subjectId: toIdString(doc?.subjectId) || subjectByTopicId.get(id) || "",
      chapterId: toIdString(doc?.chapterId) || chapterByTopicId.get(id) || chapterId,
      questionsCount: countByTopicId.get(id) ?? Number(doc?.questionsCount ?? doc?.questionCount ?? 0),
    });
  });

  topicIdsFromQuestions.forEach((id) => {
    if (outputByTopicId.has(id)) return;
    outputByTopicId.set(id, {
      id,
      name: `Topic ${id.slice(-6)}`,
      subjectId: subjectByTopicId.get(id) || "",
      chapterId: chapterByTopicId.get(id) || chapterId,
      questionsCount: countByTopicId.get(id) ?? 0,
    });
  });

  const topics = [...outputByTopicId.values()].sort((a, b) => a.name.localeCompare(b.name));
  res.json(topics);
});

export default router;
