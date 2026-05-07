import { shuffleList } from "./adaptive-testing";

const OPTION_KEYS = ["A", "B", "C", "D"] as const;

type OptionShuffleMap = Record<string, string>;

function normalizeOption(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

function remapCorrectOption(correctOption: unknown, optionShuffleMap: OptionShuffleMap) {
  const canonical = normalizeOption(correctOption);
  if (!canonical) return "";
  const entry = Object.entries(optionShuffleMap).find(([, source]) => source === canonical);
  return entry?.[0] ?? canonical;
}

function remapCorrectOptions(correctOptions: unknown, optionShuffleMap: OptionShuffleMap) {
  if (!Array.isArray(correctOptions)) return [];
  return correctOptions
    .map((item) => remapCorrectOption(item, optionShuffleMap))
    .filter(Boolean);
}

export function shuffleQuestionOptions(question: Record<string, any>) {
  const responseType = String(question?.responseType || "single").toLowerCase();
  if (responseType === "numeric") return question;

  const availableCanonicalKeys = OPTION_KEYS.filter((key) => {
    const text = String(question?.[`option${key}`] ?? "").trim();
    const image = String(question?.[`option${key}ImageUrl`] ?? "").trim();
    return Boolean(text || image);
  });

  if (availableCanonicalKeys.length <= 1) return question;

  const shuffledCanonical = shuffleList(availableCanonicalKeys);
  const optionShuffleMap: OptionShuffleMap = {};
  const nextQuestion: Record<string, any> = { ...question };

  OPTION_KEYS.forEach((displayKey, index) => {
    const sourceKey = shuffledCanonical[index];
    if (!sourceKey) {
      nextQuestion[`option${displayKey}`] = "";
      nextQuestion[`option${displayKey}ImageUrl`] = "";
      return;
    }

    optionShuffleMap[displayKey] = sourceKey;
    nextQuestion[`option${displayKey}`] = question?.[`option${sourceKey}`] ?? "";
    nextQuestion[`option${displayKey}ImageUrl`] = question?.[`option${sourceKey}ImageUrl`] ?? "";
  });

  nextQuestion.optionShuffleMap = optionShuffleMap;

  if (responseType === "multiple") {
    nextQuestion.correctOptions = remapCorrectOptions(question?.correctOptions, optionShuffleMap);
  } else {
    nextQuestion.correctOption = remapCorrectOption(question?.correctOption, optionShuffleMap);
  }

  return nextQuestion;
}

export function shuffleQuestionOptionsForDelivery(questions: Array<Record<string, any>>) {
  return questions.map((question) => shuffleQuestionOptions(question));
}
