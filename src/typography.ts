import Typograf from "typograf";

interface TypografInstance {
  execute(value: string): string;
}

const TypografConstructor = Typograf as unknown as new (preferences: {
  locale: string[];
  disableRule: string;
  enableRule: string[];
}) => TypografInstance;

// Keep Telegram typography deliberately conservative: improve presentation,
// but do not rewrite dates, numbers, phone numbers, repeated punctuation or
// keyboard-layout typos in otherwise approved text.
const TELEGRAM_TYPOGRAPHY_RULES = [
  "common/nbsp/afterParagraphMark",
  "common/nbsp/afterSectionMark",
  "common/nbsp/afterShortWord",
  "common/nbsp/afterShortWordByList",
  "common/nbsp/beforeShortLastNumber",
  "common/nbsp/beforeShortLastWord",
  "common/nbsp/dpi",
  "common/nbsp/nowrap",
  "common/punctuation/apostrophe",
  "common/punctuation/hellip",
  "common/punctuation/quote",
  "common/punctuation/quoteLink",
  "common/space/afterColon",
  "common/space/afterComma",
  "common/space/afterExclamationMark",
  "common/space/afterQuestionMark",
  "common/space/afterSemicolon",
  "common/space/beforeBracket",
  "common/space/bracket",
  "common/space/delBeforeDot",
  "common/space/delBeforePercent",
  "common/space/delBeforePunctuation",
  "common/space/delBetweenExclamationMarks",
  "common/space/delRepeatN",
  "common/space/delRepeatSpace",
  "common/space/delTrailingBlanks",
  "common/space/replaceTab",
  "common/space/squareBracket",
  "common/space/trimLeft",
  "common/space/trimRight",
  "common/symbols/cf",
  "common/symbols/copy",
  "ru/dash/centuries",
  "ru/dash/daysMonth",
  "ru/dash/decade",
  "ru/dash/directSpeech",
  "ru/dash/izpod",
  "ru/dash/izza",
  "ru/dash/ka",
  "ru/dash/kakto",
  "ru/dash/koe",
  "ru/dash/main",
  "ru/dash/month",
  "ru/dash/surname",
  "ru/dash/taki",
  "ru/dash/time",
  "ru/dash/to",
  "ru/dash/weekday",
  "ru/dash/years",
  "ru/nbsp/abbr",
  "ru/nbsp/addr",
  "ru/nbsp/afterNumberSign",
  "ru/nbsp/beforeParticle",
  "ru/nbsp/centuries",
  "ru/nbsp/dayMonth",
  "ru/nbsp/initials",
  "ru/nbsp/m",
  "ru/nbsp/mln",
  "ru/nbsp/ooo",
  "ru/nbsp/page",
  "ru/nbsp/ps",
  "ru/nbsp/rubleKopek",
  "ru/nbsp/see",
  "ru/nbsp/year",
  "ru/nbsp/years",
  "ru/space/afterHellip",
  "ru/space/year",
];

const telegramTypograf = new TypografConstructor({
  locale: ["ru", "en-US"],
  disableRule: "*",
  enableRule: TELEGRAM_TYPOGRAPHY_RULES,
});

export function typografTelegramHtml(value: string): string {
  return telegramTypograf.execute(value);
}
