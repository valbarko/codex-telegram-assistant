export class UnusableMediaTranscriptError extends Error {
  constructor(message = "Media transcript does not contain enough readable speech") {
    super(message);
    this.name = "UnusableMediaTranscriptError";
  }
}

/** Reject obvious decoder garbage, not ordinary uncertainty or imperfect prose. */
export function mediaTranscriptQualityIssue(value: string): string | undefined {
  const text = value.replace(/\[\d{2,}:\d{2}:\d{2}(?:[.,]\d+)?\]/gu, "").replace(/\s/gu, "");
  const characters = [...text].length;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!characters || !letters) return "Media transcript contains no readable words";
  if (characters >= 40 && letters / characters < 0.2) {
    return "Media transcript is almost entirely numbers or punctuation";
  }
  return undefined;
}

export function assertUsableMediaTranscript(value: string): void {
  const issue = mediaTranscriptQualityIssue(value);
  if (issue) throw new UnusableMediaTranscriptError(issue);
}
