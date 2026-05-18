import { Router, type IRouter } from "express";
import { Chapter, Question, ChapterPerformance, mongoose } from "@api/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/auth";
import { requireOnboardingComplete } from "../middlewares/onboarding";
import { buildManagedModeQuery, getAllSubjectSummaries, resolveSubjectIds } from "../lib/subjects";

const router: IRouter = Router();

function buildChapterIdVariants(chapterIds: string[]) {
  const stringIds = chapterIds.map(String).filter(Boolean);
  const objectIds = stringIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  return [...stringIds, ...objectIds];
}

async function loadChaptersBySubjectIds(subjectIds: string[]) {
  const directChapters = await Chapter.find({ subjectId: { $in: subjectIds } }).sort({ name: 1, _id: 1 });
  if (directChapters.length > 0) return directChapters;

  const objectIdSubjectIds = subjectIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const aggregateSubjectIds = [...subjectIds, ...objectIdSubjectIds];
  if (aggregateSubjectIds.length === 0) return [];

  const aggregateChapters = await Chapter.aggregate([
    {
      $match: {
        subjectId: { $in: aggregateSubjectIds },
      },
    },
    { $sort: { name: 1, _id: 1 } },
  ]);

  return aggregateChapters
    .map((chapter) => ({
      ...chapter,
      id: String(chapter.id ?? chapter._id),
      subjectId: String(chapter.subjectId ?? ""),
    }));
}

router.get("/", requireAuth, requireOnboardingComplete, async (req: AuthenticatedRequest, res) => {
  const mode = req.query["mode"] as string | undefined;

  const filter: Record<string, unknown> = buildManagedModeQuery(mode);

  res.json(await getAllSubjectSummaries(filter));
});

router.get("/:subjectId/chapters", requireAuth, requireOnboardingComplete, async (req, res) => {
  try {
    const subjectId = req.params["subjectId"];
    const userId = req.userId!;
    const isPremiumUser = Boolean(req.user?.isPremium);

    const examTypeRaw = req.query["examType"];
    const examType = examTypeRaw
      ? examTypeRaw.toString().toUpperCase()
      : undefined;

    const resolvedSubjectIdsRaw = await resolveSubjectIds(subjectId, examType ?? null);

    if (!resolvedSubjectIdsRaw.length) {
      return res.json([]);
    }

    const chapters = await loadChaptersBySubjectIds(resolvedSubjectIdsRaw);
    const chapterIds = chapters
      .map((chapter) => String(chapter?._id ?? chapter?.id ?? ""))
      .filter(Boolean);

    if (!chapterIds.length) {
      return res.json([]);
    }

    const questionFilter: Record<string, unknown> = { chapterId: { $in: buildChapterIdVariants(chapterIds) } };
    if (examType) {
      Object.assign(questionFilter, buildManagedModeQuery(examType));
    }

    let questionCounts: Array<{ _id: unknown; count?: number }> = [];
    let difficultyCounts: Array<{ _id: unknown; count?: number }> = [];
    let performances: Array<{ chapterId: string; strength?: "strong" | "medium" | "weak" | "untested"; accuracy?: number }> = [];

    const [questionCountsResult, difficultyCountsResult, performancesResult] = await Promise.allSettled([
      Question.aggregate([
        { $match: questionFilter },
        { $group: { _id: "$chapterId", count: { $sum: 1 } } },
      ]),
      Question.aggregate([
        { $match: questionFilter },
        { $group: { _id: { chapterId: "$chapterId", difficulty: "$difficulty" }, count: { $sum: 1 } } },
      ]),
      ChapterPerformance.find({
        userId,
        chapterId: { $in: chapterIds },
      }).lean(),
    ]);

    if (questionCountsResult.status === "fulfilled") {
      questionCounts = questionCountsResult.value;
    } else {
      req.log.warn({ statsError: questionCountsResult.reason, subjectId, examType }, "Chapter question counts lookup failed");
    }

    if (difficultyCountsResult.status === "fulfilled") {
      difficultyCounts = difficultyCountsResult.value;
    } else {
      req.log.warn({ statsError: difficultyCountsResult.reason, subjectId, examType }, "Chapter difficulty counts lookup failed");
    }

    if (performancesResult.status === "fulfilled") {
      performances = performancesResult.value;
    } else {
      req.log.warn({ statsError: performancesResult.reason, subjectId, examType }, "Chapter performance lookup failed");
    }

    const questionCountMap = new Map(
      questionCounts.map((q) => [String(q._id), q.count])
    );

    const difficultyCountMap = new Map<
      string,
      { easy: number; medium: number; hard: number; mixed: number }
    >();

    for (const item of difficultyCounts) {
      const chapterKey = String((item._id as any)?.chapterId ?? "");
      const difficultyKey = String((item._id as any)?.difficulty ?? "").toLowerCase();
      if (!chapterKey) continue;

      const current = difficultyCountMap.get(chapterKey) ?? { easy: 0, medium: 0, hard: 0, mixed: 0 };
      const count = Number(item.count ?? 0);
      if (difficultyKey === "easy") current.easy += count;
      else if (difficultyKey === "medium" || difficultyKey === "moderate") current.medium += count;
      else if (difficultyKey === "hard") current.hard += count;
      current.mixed += count;
      difficultyCountMap.set(chapterKey, current);
    }

    const performanceMap = new Map(
      performances.map((p) => [String(p.chapterId), p])
    );

    const result = chapters.map((chapter) => {
      const chapterData =
        typeof chapter.toJSON === "function"
          ? chapter.toJSON()
          : chapter;

      const key = String(chapter._id ?? chapter.id ?? "");

      const performance = performanceMap.get(key);

      return {
        ...chapterData,
        subjectId: String(chapter.subjectId),
        isLockedForFreeUsers: Boolean(chapterData.isLockedForFreeUsers),
        isAccessible: isPremiumUser || !Boolean(chapterData.isLockedForFreeUsers),
        accessBadge: Boolean(chapterData.isLockedForFreeUsers) ? "Premium" : "Free",
        questionsCount: questionCountMap.get(key) ?? 0,
        difficultyCounts: difficultyCountMap.get(key) ?? { easy: 0, medium: 0, hard: 0, mixed: 0 },
        strength: performance?.strength ?? "untested",
        accuracy: Math.round((performance?.accuracy ?? 0) * 100),
      };
    });

    res.json(result);
  } catch (error) {
    console.error("❌ ERROR:", error); // IMPORTANT
    res.status(500).json({
      error: "chapters_failed",
      message: "Failed to load chapters",
      debug: error instanceof Error ? error.message : error,
    });
  }
});

export default router;
