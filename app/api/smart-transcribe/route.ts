import { NextRequest, NextResponse } from "next/server";
import { Buffer } from "node:buffer";
import { getAiBinding } from "../../../lib/cloudflare";

type CloudflareAiPayload = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  messages?: string[];
  result?: unknown;
};

type InterpretContext = {
  meetingTitle?: string;
  sourceContext?: string;
  translationContext?: string;
};

const DEFAULT_WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const FALLBACK_WHISPER_MODEL = "@cf/openai/whisper";
const DEFAULT_TRANSLATE_MODEL = "@cf/meta/m2m100-1.2b";
const DEFAULT_INTERPRETER_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const LANGUAGE_ALIASES: Record<string, string> = {
  auto: "auto",
  english: "en",
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  "en-nz": "en",
  vietnamese: "vi",
  "tieng viet": "vi",
  vi: "vi",
  "vi-vn": "vi",
  spanish: "es",
  es: "es",
  french: "fr",
  fr: "fr",
  german: "de",
  de: "de",
  japanese: "ja",
  ja: "ja",
  korean: "ko",
  ko: "ko",
  chinese: "zh",
  mandarin: "zh",
  zh: "zh",
  portuguese: "pt",
  pt: "pt",
  italian: "it",
  it: "it",
  indonesian: "id",
  id: "id",
  thai: "th",
  th: "th",
  arabic: "ar",
  ar: "ar",
  hindi: "hi",
  hi: "hi",
  russian: "ru",
  ru: "ru"
};

function aiConfig() {
  const ai = getAiBinding();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || "";
  const token = process.env.CLOUDFLARE_AI_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "";
  return {
    ai,
    accountId,
    token,
    configured: Boolean(ai || (accountId && token)),
    whisperModel: process.env.CLOUDFLARE_WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
    translateModel: process.env.CLOUDFLARE_TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL,
    interpreterModel: process.env.CLOUDFLARE_INTERPRETER_MODEL || DEFAULT_INTERPRETER_MODEL
  };
}

function normalizeLanguage(value = "") {
  const key = value.trim().toLowerCase();
  if (!key) return "auto";
  return LANGUAGE_ALIASES[key] || LANGUAGE_ALIASES[key.split("_").join("-")] || key.split("-")[0] || key;
}

function guessLanguage(text: string, fallback = "en") {
  const value = text.trim();
  if (!value) return fallback;
  if (/[\u00c0-\u1ef9]/.test(value) && /[ăâđêôơưĂÂĐÊÔƠƯ]/.test(value)) return "vi";
  if (/[\u4e00-\u9fff]/.test(value)) return "zh";
  if (/[\u3040-\u30ff]/.test(value)) return "ja";
  if (/[\uac00-\ud7af]/.test(value)) return "ko";
  if (/[\u0600-\u06ff]/.test(value)) return "ar";
  if (/[\u0900-\u097f]/.test(value)) return "hi";
  if (/[\u0400-\u04ff]/.test(value)) return "ru";
  if (/[ñ¿¡]/i.test(value)) return "es";
  if (/[çœæ]|(?:\bje\b|\bvous\b|\bnous\b|\bavec\b)/i.test(value)) return "fr";
  if (/[ßäöü]/i.test(value)) return "de";
  return fallback;
}

function resultObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function textFrom(value: unknown) {
  const result = resultObject(value);
  const candidates = [
    result.text,
    result.transcription,
    result.transcript,
    result.response,
    result.translated_text,
    result.translation
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") return JSON.stringify(candidate);
  }
  return "";
}

function languageName(code: string) {
  const normalized = normalizeLanguage(code);
  return (
    {
      auto: "the speaker's language",
      en: "English",
      vi: "Vietnamese",
      fr: "French",
      es: "Spanish",
      de: "German",
      ja: "Japanese",
      ko: "Korean",
      zh: "Chinese",
      pt: "Portuguese",
      it: "Italian",
      id: "Indonesian",
      th: "Thai",
      ar: "Arabic",
      hi: "Hindi",
      ru: "Russian"
    }[normalized] || normalized
  );
}

function compactSpeechText(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\b(um+|uh+|erm+|ah+)\b[,. ]*/gi, "")
    .replace(/\b(\w+)(?:\s+\1\b){2,}/gi, "$1")
    .trim();
}

function compactContextText(value: unknown, maxLength = 1600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? text.slice(-maxLength).trimStart() : text;
}

function hasVietnameseSignals(text: string) {
  return /[ăâđêôơưĂÂĐÊÔƠƯà-ỹÀ-Ỹ]/.test(text) || /\b(mình|nguoi|người|khong|không|chua|chưa|can|cần|ghi am|ghi âm|tieng|tiếng|dich|dịch|nen|nên)\b/i.test(text);
}

function isSkippableAudioError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /invalid audio input|incomplete input|empty transcription|no speech|audio input/i.test(message);
}

function parseLooseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function parseAiResponse(res: Response) {
  const raw = await res.text();
  let payload: CloudflareAiPayload | null = null;
  try {
    payload = JSON.parse(raw) as CloudflareAiPayload;
  } catch {
    payload = null;
  }

  const errors = payload?.errors?.map((item) => item.message).filter(Boolean).join("; ");
  if (!res.ok || payload?.success === false) {
    throw new Error(errors || raw || `Cloudflare AI request failed with ${res.status}`);
  }

  return payload?.result ?? payload ?? raw;
}

async function runWorkersAi(model: string, body: BodyInit, contentType: string) {
  const { ai, accountId, token } = aiConfig();
  if (ai) {
    if (typeof body === "string" && contentType.includes("json")) {
      return ai.run(model, JSON.parse(body));
    }
    if (body instanceof ArrayBuffer) {
      return ai.run(model, { audio: Buffer.from(body).toString("base64") });
    }
    throw new Error("Unsupported Workers AI binding request body");
  }

  if (!accountId || !token) throw new Error("Cloudflare Workers AI is not configured");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType
    },
    body
  });
  return parseAiResponse(res);
}

async function transcribeAudio(audio: ArrayBuffer, mimeType: string) {
  const { whisperModel } = aiConfig();
  const models = [whisperModel, FALLBACK_WHISPER_MODEL].filter((model, index, all) => all.indexOf(model) === index);
  let lastError: Error | null = null;

  for (const model of models) {
    try {
      return {
        model,
        result: await runWorkersAi(model, audio, mimeType || "application/octet-stream")
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown transcription error");
      try {
        const audioArray = Array.from(new Uint8Array(audio));
        return {
          model,
          result: await runWorkersAi(model, JSON.stringify({ audio: audioArray }), "application/json")
        };
      } catch (fallbackError) {
        lastError = fallbackError instanceof Error ? fallbackError : lastError;
      }
    }
  }

  throw lastError || new Error("Transcription failed");
}

async function translateText(text: string, sourceLang: string, targetLang: string) {
  const { translateModel } = aiConfig();
  const normalizedSource = normalizeLanguage(sourceLang);
  const normalizedTarget = normalizeLanguage(targetLang);
  if (!text || normalizedTarget === "auto" || normalizedSource === normalizedTarget) {
    return { model: translateModel, text, sourceLang: normalizedSource, skipped: true };
  }

  const result = await runWorkersAi(
    translateModel,
    JSON.stringify({
      text,
      source_lang: normalizedSource,
      target_lang: normalizedTarget
    }),
    "application/json"
  );

  return {
    model: translateModel,
    text: textFrom(result) || text,
    sourceLang: normalizedSource,
    skipped: false
  };
}

async function interpretBilingual(rawText: string, sourceLang: string, targetLang: string, context: InterpretContext = {}) {
  const { interpreterModel } = aiConfig();
  const normalizedSource = normalizeLanguage(sourceLang);
  const normalizedTarget = normalizeLanguage(targetLang);
  const compacted = compactSpeechText(rawText);
  const sourceContext = compactContextText(context.sourceContext);
  const translationContext = compactContextText(context.translationContext);
  const meetingTitle = compactContextText(context.meetingTitle, 220);
  if (!compacted) {
    return { model: interpreterModel, sourceText: "", translatedText: "", sourceLang: normalizedSource };
  }

  const result = await runWorkersAi(
    interpreterModel,
    JSON.stringify({
      messages: [
        {
          role: "system",
          content:
            "You are a senior live conference interpreter for bilingual meeting notes. Your job is meaning-first interpretation, not word-by-word translation. Keep sourceText in the original speaker language; never translate sourceText into the target language. Use previous context only to continue the thought, resolve pronouns, keep terminology consistent, and avoid repeating text that was already translated. If this chunk starts or ends mid-sentence, make it readable while preserving the speaker's intent. Preserve proper names, product names, model names, numbers, and culturally specific terms. Translate ordinary words naturally instead of leaving them in English when the target language has a clear equivalent. Keep technical AI/product terms precise: hallucinate/hallucination means ảo giác or bịa thông tin in Vietnamese; edge cases means trường hợp biên; real-time means thời gian thực; transcript means bản ghi lời nói or transcript depending on context. For Vietnamese colloquial product feedback: 'ngon' can mean solid, polished, reliable, or good enough; 'chưa ổn' means not solid yet; 'sát ý' means faithful to the intended meaning; 'kiểu vậy' usually means something like that. Use natural punctuation and capitalization. Remove only obvious ASR noise, repeated filler, false starts, and fragments that do not change meaning. Do not add facts or summarize beyond the current chunk. Return only compact JSON."
        },
        {
          role: "user",
          content: JSON.stringify({
            meetingTitle,
            previousOriginalContext: sourceContext,
            previousTranslatedContext: translationContext,
            rawTranscript: compacted,
            detectedSourceLanguage: normalizedSource,
            targetLanguage: normalizedTarget,
            targetLanguageName: languageName(normalizedTarget),
            exampleForStyleOnly: {
              rawTranscript: "nên đoạn này mình chưa thể gọi là ngon, cần làm cho người dùng chỉ bấm ghi âm là hiểu ngay",
              targetLanguage: "en",
              sourceText: "nên đoạn này mình chưa thể gọi là ngon, cần làm cho người dùng chỉ bấm ghi âm là hiểu ngay",
              translatedText: "So I still would not call this good enough; we need to make it so users can just press Record and immediately understand what to do."
            },
            instructions: [
              "Return sourceText as the cleaned transcript for the current chunk only, in the original speaker language.",
              "Return translatedText as a natural translation for the current chunk only, using previous context for continuity.",
              "Do not translate the previous context again.",
              "If source and target are the same language, translatedText may match sourceText."
            ],
            requiredJsonShape: {
              sourceText: "cleaned transcript in the original speaker language",
              translatedText: "natural translation in the target language",
              sourceLang: "ISO 639-1 language code"
            }
          })
        }
      ],
      temperature: 0.1,
      max_tokens: 700
    }),
    "application/json"
  );

  const responseText = textFrom(result);
  const parsed = parseLooseJson(responseText);
  if (!parsed) {
    const freeform = compactSpeechText(responseText);
    if (freeform && normalizedTarget !== "auto" && normalizedSource !== normalizedTarget) {
      return {
        model: interpreterModel,
        sourceText: compacted,
        translatedText: freeform,
        sourceLang: normalizedSource
      };
    }
  }

  let interpretedSource = compactSpeechText(String(parsed?.sourceText || parsed?.source_text || compacted));
  const interpretedTarget = compactSpeechText(String(parsed?.translatedText || parsed?.translated_text || ""));
  const interpretedLang = normalizeLanguage(String(parsed?.sourceLang || parsed?.source_lang || normalizedSource));
  const sourceGuess = guessLanguage(interpretedSource, interpretedLang);
  if (normalizedSource !== "auto" && sourceGuess !== normalizedSource && sourceGuess === normalizedTarget) {
    interpretedSource = compacted;
  }
  if (
    normalizedSource === "vi" &&
    normalizedTarget !== "vi" &&
    hasVietnameseSignals(compacted) &&
    !hasVietnameseSignals(interpretedSource)
  ) {
    interpretedSource = compacted;
  }
  if (normalizedTarget !== "auto" && interpretedLang !== normalizedTarget && !interpretedTarget) {
    throw new Error("Interpreter returned an empty translation");
  }

  return {
    model: interpreterModel,
    sourceText: interpretedSource || compacted,
    translatedText: normalizedTarget === "auto" || interpretedLang === normalizedTarget
      ? interpretedSource || compacted
      : interpretedTarget,
    sourceLang: interpretedLang === "auto" ? normalizedSource : interpretedLang
  };
}

export async function GET() {
  const config = aiConfig();
  return NextResponse.json(
    {
      configured: config.configured,
      provider: config.configured ? "cloudflare-workers-ai" : "browser-fallback",
      whisperModel: config.whisperModel,
      translateModel: config.translateModel,
      interpreterModel: config.interpreterModel,
      message: config.configured
        ? "Smart Transcribe is ready."
        : "Add a Cloudflare Workers AI binding or CLOUDFLARE_AI_TOKEN to enable cloud transcription and translation."
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  try {
    const config = aiConfig();
    if (!config.configured) {
      return NextResponse.json(
        { error: "Cloudflare Workers AI is not configured. Browser recording still works locally." },
        { status: 503 }
      );
    }

    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await req.json();
      const text = String(body.text || "").trim();
      const targetLang = normalizeLanguage(String(body.targetLang || "vi"));
      const sourceLang = normalizeLanguage(String(body.sourceLang || "auto"));
      const context = {
        meetingTitle: String(body.meetingTitle || ""),
        sourceContext: String(body.sourceContext || ""),
        translationContext: String(body.translationContext || "")
      };
      if (!text) return NextResponse.json({ error: "Missing text" }, { status: 400 });
      const detectedSource = sourceLang === "auto" ? guessLanguage(text, targetLang === "en" ? "vi" : "en") : sourceLang;
      const interpreted = await interpretBilingual(text, detectedSource, targetLang, context).catch(async () => {
        const fallback = await translateText(text, detectedSource, targetLang);
        return { model: fallback.model, sourceText: compactSpeechText(text), translatedText: fallback.text, sourceLang: fallback.sourceLang };
      });
      return NextResponse.json({
        provider: "cloudflare-workers-ai",
        sourceText: interpreted.sourceText,
        translatedText: interpreted.translatedText,
        sourceLang: interpreted.sourceLang,
        targetLang,
        translateModel: interpreted.model
      });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Missing audio file" }, { status: 400 });

    const targetLang = normalizeLanguage(String(form.get("targetLang") || "vi"));
    const sourceHint = normalizeLanguage(String(form.get("sourceLang") || "auto"));
    const context = {
      meetingTitle: String(form.get("meetingTitle") || ""),
      sourceContext: String(form.get("sourceContext") || ""),
      translationContext: String(form.get("translationContext") || "")
    };
    const bytes = await file.arrayBuffer();
    const transcription = await transcribeAudio(bytes, file.type || "application/octet-stream").catch((error) => {
      if (isSkippableAudioError(error)) return null;
      throw error;
    });
    if (!transcription) {
      return NextResponse.json({
        provider: "cloudflare-workers-ai",
        skipped: true,
        reason: "Listening for clear speech"
      });
    }
    const transcriptionResult = resultObject(transcription.result);
    const rawSourceText = textFrom(transcription.result);
    if (!rawSourceText) {
      return NextResponse.json({
        provider: "cloudflare-workers-ai",
        skipped: true,
        reason: "No clear speech detected"
      });
    }

    const rawLanguage = String(
      transcriptionResult.language ||
        transcriptionResult.detected_language ||
        transcriptionResult.source_language ||
        ""
    );
    const sourceLang = sourceHint !== "auto"
      ? sourceHint
      : normalizeLanguage(rawLanguage) !== "auto"
        ? normalizeLanguage(rawLanguage)
        : guessLanguage(rawSourceText, targetLang === "en" ? "vi" : "en");
    const interpreted = await interpretBilingual(rawSourceText, sourceLang, targetLang, context).catch(async () => {
      const fallback = await translateText(rawSourceText, sourceLang, targetLang);
      return { model: fallback.model, sourceText: compactSpeechText(rawSourceText), translatedText: fallback.text, sourceLang: fallback.sourceLang };
    });

    return NextResponse.json({
      provider: "cloudflare-workers-ai",
      sourceText: interpreted.sourceText,
      translatedText: interpreted.translatedText,
      sourceLang: interpreted.sourceLang,
      targetLang,
      wordCount: Number(transcriptionResult.word_count || interpreted.sourceText.split(/\s+/).filter(Boolean).length),
      whisperModel: transcription.model,
      translateModel: interpreted.model,
      rawSourceText,
      vtt: typeof transcriptionResult.vtt === "string" ? transcriptionResult.vtt : ""
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown smart transcribe error" },
      { status: 500 }
    );
  }
}
