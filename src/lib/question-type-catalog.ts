import { QuestionType } from "@api/db";

export type QuestionTypeCatalogItem = {
  name: string;
  mode: "NEET" | "JEE" | "BOTH";
  examCategory: "NEET" | "JEE_MAIN" | "JEE_ADVANCED";
  responseType: "single" | "multiple" | "numeric";
  displayVariant: "single_choice" | "multiple_choice" | "numeric" | "assertion_reasoning" | "statement_set" | "matching" | "diagram";
  description: string;
  exampleQuestion: string;
  exampleOptions: string;
  exampleAnswer: string;
  exampleExplanation: string;
};

export const QUESTION_TYPE_CATALOG: QuestionTypeCatalogItem[] = [
  {
    name: "Multiple Choice Questions (MCQs)",
    mode: "NEET",
    examCategory: "NEET",
    responseType: "single",
    displayVariant: "single_choice",
    description: "Standard four-option single-correct questions used heavily across NEET.",
    exampleQuestion: "Which organelle is known as the powerhouse of the cell?",
    exampleOptions: "A. Ribosome\nB. Mitochondria\nC. Golgi body\nD. Nucleus",
    exampleAnswer: "B. Mitochondria",
    exampleExplanation: "A standard single-correct MCQ with four options.",
  },
  {
    name: "Assertion-Reasoning",
    mode: "NEET",
    examCategory: "NEET",
    responseType: "single",
    displayVariant: "assertion_reasoning",
    description: "Tests direct conceptual understanding, especially in Biology and Chemistry.",
    exampleQuestion: "Assertion: Enzymes are biological catalysts. Reason: Enzymes increase activation energy of a reaction.",
    exampleOptions: "A. Both true and reason explains assertion\nB. Both true but reason does not explain assertion\nC. Assertion true, reason false\nD. Assertion false, reason true",
    exampleAnswer: "C. Assertion true, reason false",
    exampleExplanation: "Shows the assertion-reasoning layout expected in the app.",
  },
  {
    name: "Statement-based Questions",
    mode: "NEET",
    examCategory: "NEET",
    responseType: "single",
    displayVariant: "statement_set",
    description: "Chooses the correct or incorrect set of statements to test detailed NCERT knowledge.",
    exampleQuestion: "Consider the following statements about xylem: 1. It conducts water. 2. It is made only of living cells. Choose the correct option.",
    exampleOptions: "A. Only 1 is correct\nB. Only 2 is correct\nC. Both are correct\nD. Neither is correct",
    exampleAnswer: "A. Only 1 is correct",
    exampleExplanation: "Useful for statement-based and NCERT detail questions.",
  },
  {
    name: "Matching Type",
    mode: "NEET",
    examCategory: "NEET",
    responseType: "single",
    displayVariant: "matching",
    description: "Pairs items across lists to test application and conceptual linkage.",
    exampleQuestion: "Match Column I with Column II and choose the correct option.",
    exampleOptions: "A. 1-a, 2-b, 3-c, 4-d\nB. 1-b, 2-a, 3-d, 4-c\nC. 1-c, 2-d, 3-a, 4-b\nD. 1-d, 2-c, 3-b, 4-a",
    exampleAnswer: "A. 1-a, 2-b, 3-c, 4-d",
    exampleExplanation: "Represents matching-list style NEET questions.",
  },
  {
    name: "Diagram-based Questions",
    mode: "NEET",
    examCategory: "NEET",
    responseType: "single",
    displayVariant: "diagram",
    description: "Common in Biology for identifying structures and reading labeled figures.",
    exampleQuestion: "Identify the marked part in the diagram of a nephron.",
    exampleOptions: "A. Bowman capsule\nB. Loop of Henle\nC. Collecting duct\nD. Glomerulus",
    exampleAnswer: "B. Loop of Henle",
    exampleExplanation: "Diagram-driven visual questions should use this display variant.",
  },
  {
    name: "MCQs (Single Correct)",
    mode: "JEE",
    examCategory: "JEE_MAIN",
    responseType: "single",
    displayVariant: "single_choice",
    description: "Standard single-correct MCQs for Physics, Chemistry, and Mathematics.",
    exampleQuestion: "The SI unit of electric field is:",
    exampleOptions: "A. N/C\nB. C/N\nC. J/C\nD. V/m only",
    exampleAnswer: "A. N/C",
    exampleExplanation: "A typical JEE Main single-correct MCQ.",
  },
  {
    name: "Numerical Value-based Questions",
    mode: "JEE",
    examCategory: "JEE_MAIN",
    responseType: "numeric",
    displayVariant: "numeric",
    description: "Requires entering a calculated numeric answer directly with no options.",
    exampleQuestion: "A particle travels 20 m in 4 s. Find its speed in m/s.",
    exampleOptions: "",
    exampleAnswer: "5",
    exampleExplanation: "Numeric-entry question without options.",
  },
  {
    name: "Multi-Option Questions",
    mode: "JEE",
    examCategory: "JEE_ADVANCED",
    responseType: "multiple",
    displayVariant: "multiple_choice",
    description: "Allows selecting more than one correct option, mostly in JEE Advanced.",
    exampleQuestion: "Which of the following are vector quantities?",
    exampleOptions: "A. Displacement\nB. Speed\nC. Velocity\nD. Acceleration",
    exampleAnswer: "A, C, D",
    exampleExplanation: "Multiple-correct layout where more than one option may be valid.",
  },
  {
    name: "Assertion-Reasoning",
    mode: "JEE",
    examCategory: "JEE_MAIN",
    responseType: "single",
    displayVariant: "assertion_reasoning",
    description: "Focuses on theoretical application and reasoning-based validation.",
    exampleQuestion: "Assertion: Work done in circular motion can be zero. Reason: Displacement may be perpendicular to force.",
    exampleOptions: "A. Both true and reason explains assertion\nB. Both true but reason does not explain assertion\nC. Assertion true, reason false\nD. Assertion false, reason true",
    exampleAnswer: "A. Both true and reason explains assertion",
    exampleExplanation: "JEE assertion-reasoning preview.",
  },
];

function buildQuestionTypeKey(item: Pick<QuestionTypeCatalogItem, "name" | "mode" | "examCategory">) {
  return `${item.mode}_${item.examCategory}_${item.name}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export async function syncQuestionTypeCatalog() {
  const indexes = await QuestionType.collection.indexes().catch(() => []);
  if (indexes.some((index) => index.name === "name_1")) {
    await QuestionType.collection.dropIndex("name_1").catch(() => undefined);
  }

  await Promise.all(
    QUESTION_TYPE_CATALOG.map((item) =>
      QuestionType.findOneAndUpdate(
        { key: buildQuestionTypeKey(item) },
        { $set: { ...item, key: buildQuestionTypeKey(item), label: item.name } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ),
    ),
  );
}
