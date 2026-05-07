import { Difficulty } from "@api/db";

export const DIFFICULTY_CATALOG = [
  { key: "easy", name: "Easy", description: "Basic and direct questions.", sortOrder: 1 },
  { key: "moderate", name: "Moderate", description: "Intermediate conceptual and application questions.", sortOrder: 2 },
  { key: "hard", name: "Hard", description: "Challenging questions requiring deeper understanding.", sortOrder: 3 },
  { key: "mixed", name: "Mixed", description: "A combined set across all difficulty levels.", sortOrder: 4 },
] as const;

export async function syncDifficultyCatalog() {
  await Promise.all(
    DIFFICULTY_CATALOG.map((item) =>
      Difficulty.findOneAndUpdate(
        { key: item.key },
        { $set: item },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ),
    ),
  );
}
