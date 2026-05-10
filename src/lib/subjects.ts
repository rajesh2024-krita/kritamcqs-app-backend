import { Chapter, Question, Subject, mongoose, type ISubject } from "@api/db";

export type ManagedMode = string;
export type ManagedExamType = string;

export type SubjectSummary = {
  id: string;
  name: string;
  examMode: string;
  examType?: string;
  icon?: string;
  color?: string;
  totalChapters?: number;
  questionsCount?: number;
  sourceSubjectIds?: string[];
};

function normalizeMode(mode?: string | null): ManagedMode {
  return String(mode || "").trim() || "BOTH";
}

function normalizeName(name?: string) {
  return String(name ?? "").trim().toLowerCase();
  
}

function toSubjectSlug(name?: string) {
  return normalizeName(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function getSubjectNameKey(subject: Pick<ISubject, "name"> | Record<string, any>) {
  return normalizeName(subject.name);
}

function getSubjectMode(subject: Pick<ISubject, "examMode" | "examType"> | Record<string, any>): ManagedMode | undefined {
  const mode = subject.examType ?? subject.examMode;
  if (mode) return String(mode);
  if (mode === "JEE_MAIN" || mode === "JEE_ADVANCED") return "JEE";
  return undefined;
}

function getRequestedMode(filter: Record<string, unknown>): ManagedMode | undefined {
  const rawMode = typeof filter.examMode === "string" ? filter.examMode : typeof filter.examType === "string" ? filter.examType : undefined;
  if (rawMode) return rawMode;
  if (rawMode === "JEE_MAIN" || rawMode === "JEE_ADVANCED") return "JEE";
  return undefined;
}

function getSubjectIdentityKey(subject: Pick<ISubject, "name" | "examMode" | "examType"> | Record<string, any>) {
  return `${getSubjectNameKey(subject)}::${getSubjectMode(subject) ?? "NEET"}`;
}

function pickSubjectsForMode(subjects: ISubject[], requestedMode?: ManagedMode) {
  if (!requestedMode || requestedMode === "BOTH") return subjects;

  return subjects.filter((subject) => {
    const mode = getSubjectMode(subject);
    return mode === requestedMode || mode === "BOTH";
  });
}

function toSummary(subject: ISubject | Record<string, any>): SubjectSummary {
  const raw = typeof (subject as any).toJSON === "function" ? (subject as any).toJSON() : subject;
  const examMode = getSubjectMode(raw);
  return {
    id: String(raw.id ?? raw._id),
    name: String(raw.name ?? ""),
    examMode: examMode ?? "NEET",
    examType: examMode ?? "NEET",
    icon: raw.icon,
    color: raw.color,
    sourceSubjectIds: [String(raw.id ?? raw._id)],
  };
}

async function getChapterCountMap() {
  const chapterCounts = await Chapter.aggregate([
    {
      $project: {
        subjectIdText: { $toString: "$subjectId" },
      },
    },
    {
      $group: {
        _id: "$subjectIdText",
        count: { $sum: 1 },
      },
    },
  ]);

  return new Map(chapterCounts.map((item) => [String(item._id), Number(item.count ?? 0)]));
}

async function getQuestionCountMapByModes(examModes?: string[]) {
  const pipeline: Record<string, unknown>[] = [];

  if (examModes && examModes.length > 0) {
    pipeline.push({
      $match: {
        examMode: { $in: examModes },
      },
    });
  }

  pipeline.push(
    {
      $project: {
        subjectIdText: { $toString: "$subjectId" },
      },
    },
    {
      $group: {
        _id: "$subjectIdText",
        count: { $sum: 1 },
      },
    },
  );

  const counts = await Question.aggregate(pipeline);
  return new Map(counts.map((item) => [String(item._id), Number(item.count ?? 0)]));
}

async function getSubjectGroupIds(subjectId: string, examType?: ManagedExamType | null) {
  const direct = await Subject.findById(subjectId);
  if (!direct) return [];

  const identityKey = getSubjectIdentityKey(direct);
  const grouped = await Subject.find().sort({ createdAt: 1, _id: 1 });
  const related = grouped
    .filter((subject) => getSubjectIdentityKey(subject) === identityKey)
    .map((subject) => String(subject._id));

  if (examType) {
    const examMatchedIds = grouped
      .filter((subject) => getSubjectIdentityKey(subject) === identityKey)
      .filter((subject) => {
        const mode = getSubjectMode(subject);
        return mode === examType || mode === "BOTH";
      })
      .map((subject) => String(subject._id));

    if (examMatchedIds.length > 0) {
      return [...new Set(examMatchedIds)];
    }
  }

  const directId = String(direct._id);
  const chapterCountMap = await getChapterCountMap();
  const directChapterCount = chapterCountMap.get(directId) ?? 0;
  if (directChapterCount > 0) {
    return [directId];
  }

  return related.length > 0 ? related : [directId];
}

export async function resolveSubjectIds(subjectId?: string, examType?: ManagedExamType | null) {
  if (!subjectId || subjectId === "ALL") return [];

  const normalizedSubjectId = subjectId.trim();
  if (mongoose.isValidObjectId(normalizedSubjectId)) {
    const direct = await Subject.findById(normalizedSubjectId);
    if (!direct) return [];

    return getSubjectGroupIds(String(direct._id), examType);
  }

  const requestedSlug = normalizeName(normalizedSubjectId);
  const subjects = await Subject.find(examType ? { $or: [{ examMode: examType }, { examMode: "BOTH" }, { examType }] } : {});
  const matched = subjects.filter((subject) => {
    const subjectName = normalizeName(subject.name);
    const slug = toSubjectSlug(subject.name);
    const fallbackId = `${String(getSubjectMode(subject) ?? "NEET").toLowerCase()}-${slug}`;
    return requestedSlug === subjectName || requestedSlug === slug || requestedSlug === fallbackId;
  });

  const matchedIds = matched.map((subject) => String(subject._id));
  if (matchedIds.length === 0) return [];

  const matchedNames = new Set(matched.map((subject) => getSubjectIdentityKey(subject)));
  const grouped = await Subject.find(examType ? { $or: [{ examMode: examType }, { examMode: "BOTH" }, { examType }] } : {}).sort({ createdAt: 1, _id: 1 });
  const relatedIds = grouped
    .filter((subject) => matchedNames.has(getSubjectIdentityKey(subject)))
    .map((subject) => String(subject._id));

  return [...new Set([...matchedIds, ...relatedIds])];
}

export function getQuestionExamModes(mode?: string) {
  if (!mode) return [];
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === "BOTH") return ["NEET", "JEE", "BOTH"];
  return [normalizedMode, "BOTH"];
}

export function normalizeQuestionSubject(subject?: string) {
  const normalized = normalizeName(subject);
  if (normalized === "biology" || normalized === "botany" || normalized === "zoology") return "Biology";
  if (normalized === "physics") return "Physics";
  if (normalized === "chemistry") return "Chemistry";
  if (normalized === "mathematics" || normalized === "maths" || normalized === "math") return "Mathematics";
  return undefined;
}

export function isValidExamSubjectCombination(examMode?: string, subject?: string) {
  const normalizedSubject = normalizeQuestionSubject(subject);
  if (!normalizedSubject) return false;
  if (examMode === "NEET") return ["Biology", "Physics", "Chemistry"].includes(normalizedSubject);
  if (examMode === "JEE") return ["Physics", "Chemistry", "Mathematics"].includes(normalizedSubject);
  if (examMode === "BOTH") return true;
  return false;
}

export async function getAllSubjectSummaries(filter: Record<string, unknown>) {
  const allSubjects = await Subject.find().sort({ createdAt: 1, _id: 1 });
  const subjects = await Subject.find(filter).sort({ createdAt: 1, _id: 1 });
  const requestedMode = getRequestedMode(filter);
  const subjectGroups = new Map<string, ISubject[]>();

  for (const subject of allSubjects) {
    const key = getSubjectIdentityKey(subject);
    const existing = subjectGroups.get(key) ?? [];
    existing.push(subject);
    subjectGroups.set(key, existing);
  }

  const [chapterCountMap, neetQuestionCountMap, jeeQuestionCountMap, allQuestionCountMap] = await Promise.all([
    getChapterCountMap(),
    getQuestionCountMapByModes(["NEET", "BOTH"]),
    getQuestionCountMapByModes(["JEE", "BOTH"]),
    getQuestionCountMapByModes(),
  ]);

  const visibleSubjects = pickSubjectsForMode(subjects, requestedMode);

  return visibleSubjects.map((subject) => {
    const raw = typeof (subject as any).toJSON === "function" ? (subject as any).toJSON() : subject;
    const key = getSubjectIdentityKey(raw);
    const relatedSubjects = subjectGroups.get(key) ?? [subject];
    const currentSubjectId = String(raw.id ?? raw._id);
    const sourceSubjectIds = [currentSubjectId, ...relatedSubjects.map((item) => String(item._id)).filter((id) => id !== currentSubjectId)];
    const questionMode = getSubjectMode(raw);

    const totalChapters = sourceSubjectIds.reduce((sum, id) => sum + (chapterCountMap.get(id) ?? 0), 0);
    const questionsCount =
      questionMode === "NEET"
        ? sourceSubjectIds.reduce((sum, id) => sum + (neetQuestionCountMap.get(id) ?? 0), 0)
        : questionMode === "JEE"
          ? sourceSubjectIds.reduce((sum, id) => sum + (jeeQuestionCountMap.get(id) ?? 0), 0)
          : sourceSubjectIds.reduce((sum, id) => sum + (allQuestionCountMap.get(id) ?? 0), 0);

    return {
      ...toSummary(raw),
      totalChapters,
      questionsCount,
      sourceSubjectIds,
    };
  });
}
