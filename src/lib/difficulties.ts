import { Difficulty, mongoose } from "@api/db";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeDifficultyKey(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "medium") return "moderate";
  return normalized;
}

export async function resolveDifficultySelection(input: { difficulty?: unknown; difficultyId?: unknown }) {
  const requestedId = String(input.difficultyId ?? "").trim();
  const requestedKey = normalizeDifficultyKey(input.difficulty);

  if (requestedId && mongoose.isValidObjectId(requestedId)) {
    const difficulty = await Difficulty.findById(requestedId);
    if (difficulty) {
      return {
        difficultyId: String(difficulty._id),
        difficultyKey: normalizeDifficultyKey(difficulty.key ?? difficulty.name),
        difficultyName: String(difficulty.name ?? difficulty.key ?? "").trim(),
      };
    }
  }

  if (requestedKey) {
    const escaped = escapeRegex(requestedKey);
    const difficulty = await Difficulty.findOne({
      $or: [
        { key: requestedKey },
        { name: { $regex: `^${escaped}$`, $options: "i" } },
      ],
    });

    if (difficulty) {
      return {
        difficultyId: String(difficulty._id),
        difficultyKey: normalizeDifficultyKey(difficulty.key ?? difficulty.name),
        difficultyName: String(difficulty.name ?? difficulty.key ?? "").trim(),
      };
    }
  }

  const fallbackKey = requestedKey || "easy";
  return {
    difficultyId: undefined,
    difficultyKey: fallbackKey,
    difficultyName: fallbackKey,
  };
}

export async function buildDifficultyQuery(difficulty?: unknown) {
  const normalizedDifficulty = normalizeDifficultyKey(difficulty);
  if (!normalizedDifficulty || normalizedDifficulty === "mixed" || normalizedDifficulty === "all") {
    return undefined;
  }

  const resolved = await resolveDifficultySelection({ difficulty: normalizedDifficulty });
  const legacyRegex =
    normalizedDifficulty === "moderate"
      ? /^(medium|moderate)$/i
      : new RegExp(`^${escapeRegex(normalizedDifficulty)}$`, "i");

  if (!resolved.difficultyId) {
    return { difficulty: legacyRegex };
  }

  return {
    $or: [
      { difficultyId: resolved.difficultyId },
      { difficulty: legacyRegex },
    ],
  };
}
