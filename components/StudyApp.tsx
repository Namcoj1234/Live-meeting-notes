"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { StudyNote } from "../lib/types";

const LOCAL_KEY = "lmn-smart-transcribe-local";
const CHUNK_MS = 8000;
const CLOUD_RESTART_MS = 120;
const MIN_CLOUD_AUDIO_BYTES = 1400;
const SPEECH_AUDIO_BITS = 64000;
const MIN_VOICE_LEVEL = 2;
const CONTEXT_SEGMENTS = 5;
const LIVE_DRAFT_LIMIT = 520;
const MAX_LOCAL_SESSIONS = 30;

type AiStatus = {
  configured: boolean;
  provider: string;
  whisperModel?: string;
  translateModel?: string;
  message?: string;
};

type LanguageOption = {
  code: string;
  label: string;
  speechCode: string;
};

type Segment = {
  id: string;
  clipIndex: number;
  startedAt: string;
  endedAt: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  captureSource?: CaptureSource;
  origin: "cloud" | "browser" | "manual";
  status: "ready" | "error";
  error?: string;
};

type MeetingSession = {
  id: string;
  title: string;
  host: string;
  date: string;
  targetLang: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  segments: Segment[];
  lastSavedAt?: string;
};

type LocalStore = {
  userName?: string;
  targetLang?: string;
  speechLang?: string;
  inputSource?: CaptureSource;
  mode?: "smart" | "browser";
  sessions?: MeetingSession[];
};

type SegmentContext = {
  meetingTitle: string;
  sourceContext: string;
  translationContext: string;
};

type CaptureSource = "mic" | "meeting" | "file";

const CAPTURE_SOURCES: Array<{ value: CaptureSource; label: string; short: string }> = [
  { value: "mic", label: "Mic", short: "Voice" },
  { value: "meeting", label: "Meeting", short: "Tab audio" },
  { value: "file", label: "Media", short: "Local file" }
];

const NATIVE_LANGUAGES: LanguageOption[] = [
  { code: "vi", label: "Vietnamese", speechCode: "vi-VN" },
  { code: "en", label: "English", speechCode: "en-US" },
  { code: "fr", label: "French", speechCode: "fr-FR" },
  { code: "es", label: "Spanish", speechCode: "es-ES" },
  { code: "de", label: "German", speechCode: "de-DE" },
  { code: "ja", label: "Japanese", speechCode: "ja-JP" },
  { code: "ko", label: "Korean", speechCode: "ko-KR" },
  { code: "zh", label: "Chinese", speechCode: "zh-CN" },
  { code: "pt", label: "Portuguese", speechCode: "pt-BR" },
  { code: "it", label: "Italian", speechCode: "it-IT" },
  { code: "id", label: "Indonesian", speechCode: "id-ID" },
  { code: "th", label: "Thai", speechCode: "th-TH" },
  { code: "ar", label: "Arabic", speechCode: "ar-SA" },
  { code: "hi", label: "Hindi", speechCode: "hi-IN" },
  { code: "ru", label: "Russian", speechCode: "ru-RU" }
];

const SPEECH_LANGUAGES = [
  { code: "auto", label: "Auto" },
  { code: "en-US", label: "English US" },
  { code: "vi-VN", label: "Vietnamese" },
  { code: "fr-FR", label: "French" },
  { code: "es-ES", label: "Spanish" },
  { code: "de-DE", label: "German" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "zh-CN", label: "Chinese" },
  { code: "it-IT", label: "Italian" },
  { code: "id-ID", label: "Indonesian" },
  { code: "th-TH", label: "Thai" },
  { code: "ar-SA", label: "Arabic" },
  { code: "hi-IN", label: "Hindi" },
  { code: "ru-RU", label: "Russian" }
];

function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function displayTime(value?: string) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return value;
  }
}

function safeFilename(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "meeting";
}

function wordCount(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function compactLiveDraft(text: string) {
  const compacted = text.replace(/\s+/g, " ").trim();
  return compacted.length > LIVE_DRAFT_LIMIT ? compacted.slice(-LIVE_DRAFT_LIMIT).trimStart() : compacted;
}

function captureSourceLabel(value: CaptureSource) {
  return CAPTURE_SOURCES.find((item) => item.value === value)?.label || "Audio";
}

function captureStreamFromMedia(element: HTMLMediaElement) {
  const mediaElement = element as HTMLMediaElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  return mediaElement.captureStream?.() || mediaElement.mozCaptureStream?.() || null;
}

async function waitForMediaReady(element: HTMLMediaElement) {
  if (element.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Media file is not ready yet"));
    }, 7000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      element.removeEventListener("loadeddata", onReady);
      element.removeEventListener("canplay", onReady);
      element.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Cannot read this media file"));
    };
    element.addEventListener("loadeddata", onReady, { once: true });
    element.addEventListener("canplay", onReady, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

function languageLabel(code: string) {
  return NATIVE_LANGUAGES.find((item) => item.code === code)?.label || code.toUpperCase();
}

function browserTargetLanguage() {
  if (typeof navigator === "undefined") return "vi";
  const code = (navigator.language || "").split("-")[0].toLowerCase();
  return NATIVE_LANGUAGES.some((item) => item.code === code) ? code : "vi";
}

function readLocal(): LocalStore {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeLocal(store: LocalStore) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(store));
}

function chooseMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function createSpeechRecorder(stream: MediaStream) {
  const mimeType = chooseMimeType();
  const options: MediaRecorderOptions = { audioBitsPerSecond: SPEECH_AUDIO_BITS };
  if (mimeType) options.mimeType = mimeType;
  return new MediaRecorder(stream, options);
}

function downloadText(filename: string, text: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sessionMarkdown(session: MeetingSession) {
  const rows = session.segments
    .filter((segment) => segment.sourceText || segment.translatedText)
    .sort((a, b) => a.clipIndex - b.clipIndex)
    .map((segment) => [
      `## ${displayTime(segment.startedAt)} - ${displayTime(segment.endedAt)} (${segment.sourceLang} -> ${segment.targetLang})`,
      "",
      "Original:",
      segment.sourceText || "(empty)",
      "",
      `${languageLabel(segment.targetLang)}:`,
      segment.translatedText || "(not translated)"
    ].join("\n"));

  return [
    `# ${session.title}`,
    "",
    `Host: ${session.host || "Personal"}`,
    `Date: ${session.date}`,
    `Target language: ${languageLabel(session.targetLang)}`,
    `Created: ${session.createdAt}`,
    session.endedAt ? `Ended: ${session.endedAt}` : "",
    "",
    rows.length ? rows.join("\n\n---\n\n") : "No transcript segments yet."
  ].filter(Boolean).join("\n");
}

function newSession(host: string, targetLang: string): MeetingSession {
  const now = new Date().toISOString();
  return {
    id: uid("meeting"),
    title: `Meeting ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    host,
    date: todayIso(),
    targetLang,
    createdAt: now,
    updatedAt: now,
    segments: []
  };
}

export default function StudyApp() {
  const [hydrated, setHydrated] = useState(false);
  const [userName, setUserName] = useState("Personal");
  const [targetLang, setTargetLang] = useState("vi");
  const [speechLang, setSpeechLang] = useState("auto");
  const [inputSource, setInputSource] = useState<CaptureSource>("mic");
  const [mode, setMode] = useState<"smart" | "browser">("smart");
  const [sessions, setSessions] = useState<MeetingSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [recording, setRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [engineMessage, setEngineMessage] = useState("Ready");
  const [storageMessage, setStorageMessage] = useState("Local memory ready");
  const [dbEnabled, setDbEnabled] = useState(false);
  const [cloudNotes, setCloudNotes] = useState<StudyNote[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ configured: false, provider: "browser-fallback" });
  const [showDetails, setShowDetails] = useState(false);
  const [localMediaUrl, setLocalMediaUrl] = useState("");
  const [localMediaName, setLocalMediaName] = useState("");
  const [localMediaKind, setLocalMediaKind] = useState<"audio" | "video">("audio");

  const cloudRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const localMediaRef = useRef<HTMLMediaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const browserDraftRef = useRef("");
  const sessionsRef = useRef<MeetingSession[]>([]);
  const cloudVoicePeakRef = useRef(0);
  const keepRecordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const cloudSegmentTimerRef = useRef<number | null>(null);
  const clipIndexRef = useRef(1);
  const activeSessionIdRef = useRef("");
  const pendingSessionRef = useRef<MeetingSession | null>(null);
  const targetLangRef = useRef(targetLang);
  const speechLangRef = useRef(speechLang);
  const inputSourceRef = useRef<CaptureSource>(inputSource);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || sessions[0],
    [sessions, activeSessionId]
  );

  const sortedSegments = useMemo(
    () => [...(activeSession?.segments || [])].sort((a, b) => a.clipIndex - b.clipIndex),
    [activeSession]
  );

  const stats = useMemo(() => {
    const source = sortedSegments.map((segment) => segment.sourceText).join(" ");
    const translated = sortedSegments.map((segment) => segment.translatedText).join(" ");
    const started = activeSession?.createdAt ? new Date(activeSession.createdAt).getTime() : Date.now();
    const ended = activeSession?.endedAt ? new Date(activeSession.endedAt).getTime() : Date.now();
    return {
      minutes: Math.max(0, Math.round((ended - started) / 60000)),
      segments: sortedSegments.length,
      sourceWords: wordCount(source),
      translatedWords: wordCount(translated)
    };
  }, [activeSession, sortedSegments]);

  useEffect(() => {
    const local = readLocal();
    const loadedSessions = (local.sessions || []).slice(0, MAX_LOCAL_SESSIONS);
    setUserName(local.userName || "Personal");
    setTargetLang(local.targetLang || browserTargetLanguage());
    setSpeechLang(local.speechLang || "auto");
    setInputSource(local.inputSource || "mic");
    setMode(local.mode || "smart");
    setSessions(loadedSessions);
    setActiveSessionId(loadedSessions[0]?.id || "");
    sessionsRef.current = loadedSessions;
    activeSessionIdRef.current = loadedSessions[0]?.id || "";
    setHydrated(true);
    void refreshAiStatus();
    void refreshSavedNotes();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeLocal({
      userName,
      targetLang,
      speechLang,
      inputSource,
      mode,
      sessions: sessions.slice(0, MAX_LOCAL_SESSIONS)
    });
  }, [hydrated, userName, targetLang, speechLang, inputSource, mode, sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    targetLangRef.current = targetLang;
    speechLangRef.current = speechLang;
    inputSourceRef.current = inputSource;
  }, [targetLang, speechLang, inputSource]);

  useEffect(() => {
    if (inputSource !== "mic" && mode !== "smart") setMode("smart");
  }, [inputSource, mode]);

  useEffect(() => {
    return () => {
      if (localMediaUrl) URL.revokeObjectURL(localMediaUrl);
    };
  }, [localMediaUrl]);

  function currentActiveSessionSnapshot() {
    const currentId = activeSessionIdRef.current;
    return (
      sessionsRef.current.find((session) => session.id === currentId) ||
      pendingSessionRef.current ||
      activeSession ||
      sessionsRef.current[0] ||
      null
    );
  }

  function resetLiveDraft() {
    browserDraftRef.current = "";
    setInterimTranscript("");
  }

  function updateLiveDraft(finalText: string, interimText: string) {
    if (finalText) browserDraftRef.current = compactLiveDraft([browserDraftRef.current, finalText].filter(Boolean).join(" "));
    const visibleDraft = compactLiveDraft([browserDraftRef.current, interimText].filter(Boolean).join(" "));
    setInterimTranscript(visibleDraft);
  }

  function recentSegmentContext(): SegmentContext {
    const session = currentActiveSessionSnapshot();
    const recent = [...(session?.segments || [])]
      .filter((segment) => segment.status === "ready" && (segment.sourceText || segment.translatedText))
      .slice(-CONTEXT_SEGMENTS);
    return {
      meetingTitle: session?.title || "",
      sourceContext: recent.map((segment) => segment.sourceText).filter(Boolean).join("\n"),
      translationContext: recent.map((segment) => segment.translatedText).filter(Boolean).join("\n")
    };
  }

  function ensureActiveSession() {
    const current = currentActiveSessionSnapshot();
    if (current) return current;
    if (pendingSessionRef.current) return pendingSessionRef.current;
    const session = newSession(userName, targetLang);
    pendingSessionRef.current = session;
    activeSessionIdRef.current = session.id;
    sessionsRef.current = [session, ...sessionsRef.current].slice(0, MAX_LOCAL_SESSIONS);
    setSessions(sessionsRef.current);
    setActiveSessionId(session.id);
    return session;
  }

  function updateActiveSession(updater: (session: MeetingSession) => MeetingSession) {
    if (!activeSessionIdRef.current) {
      const session = pendingSessionRef.current || activeSession || newSession(userName, targetLang);
      pendingSessionRef.current = session;
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
    }

    setSessions((prev) => {
      const current =
        prev.find((session) => session.id === activeSessionIdRef.current) ||
        pendingSessionRef.current ||
        prev[0] ||
        newSession(userName, targetLang);
      pendingSessionRef.current = null;
      activeSessionIdRef.current = current.id;
      const exists = prev.some((session) => session.id === current.id);
      const nextSession = updater(current);
      const next = exists
        ? prev.map((session) => (session.id === current.id ? nextSession : session))
        : [nextSession, ...prev];
      const sortedNext = next
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, MAX_LOCAL_SESSIONS);
      sessionsRef.current = sortedNext;
      return sortedNext;
    });
  }

  function addSegment(segment: Segment) {
    updateActiveSession((session) => ({
      ...session,
      targetLang: targetLangRef.current,
      updatedAt: new Date().toISOString(),
      segments: [...session.segments, segment].sort((a, b) => a.clipIndex - b.clipIndex)
    }));
  }

  async function refreshAiStatus() {
    try {
      const res = await fetch("/api/smart-transcribe", { cache: "no-store" });
      const payload = (await res.json()) as AiStatus;
      setAiStatus(payload);
      setEngineMessage(payload.message || "Ready");
    } catch {
      setAiStatus({ configured: false, provider: "browser-fallback" });
      setEngineMessage("Smart endpoint unavailable; browser mode only");
    }
  }

  async function refreshSavedNotes() {
    try {
      const res = await fetch(`/api/state?date=${todayIso()}`, { cache: "no-store" });
      const payload = await res.json();
      setDbEnabled(Boolean(payload.dbEnabled));
      setCloudNotes((payload.notes || []) as StudyNote[]);
      setStorageMessage(payload.dbEnabled ? "Cloudflare text storage connected" : payload.message || "Local memory ready");
    } catch {
      setDbEnabled(false);
      setCloudNotes([]);
      setStorageMessage("Local memory ready");
    }
  }

  function createFreshSession() {
    const session = newSession(userName, targetLang);
    pendingSessionRef.current = null;
    activeSessionIdRef.current = session.id;
    sessionsRef.current = [session, ...sessionsRef.current].slice(0, MAX_LOCAL_SESSIONS);
    setSessions(sessionsRef.current);
    setActiveSessionId(session.id);
    resetLiveDraft();
    clipIndexRef.current = 1;
    setShowDetails(false);
    setEngineMessage("New meeting ready");
  }

  function changeTargetLanguage(value: string) {
    targetLangRef.current = value;
    setTargetLang(value);
    if (activeSessionIdRef.current || activeSession) {
      updateActiveSession((session) => ({ ...session, targetLang: value, updatedAt: new Date().toISOString() }));
    }
  }

  function changeSpeechLanguage(value: string) {
    speechLangRef.current = value;
    setSpeechLang(value);
  }

  function changeInputSource(value: CaptureSource) {
    if (recording) {
      setEngineMessage("Stop before switching source");
      return;
    }
    inputSourceRef.current = value;
    setInputSource(value);
    if (value !== "mic" && mode !== "smart") setMode("smart");
    resetLiveDraft();
    setEngineMessage(`${captureSourceLabel(value)} source ready`);
  }

  function handleLocalMediaFile(file?: File) {
    if (!file) return;
    if (localMediaUrl) URL.revokeObjectURL(localMediaUrl);
    const url = URL.createObjectURL(file);
    setLocalMediaUrl(url);
    setLocalMediaName(file.name);
    setLocalMediaKind(file.type.startsWith("video/") ? "video" : "audio");
    changeInputSource("file");
  }

  async function openMeetingAudioStream() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Meeting audio capture is not available in this browser");
    }
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        systemAudio: "include",
        suppressLocalAudioPlayback: false
      } as any
    } as any);
    displayStreamRef.current = displayStream;
    const audioTracks = displayStream.getAudioTracks();
    if (!audioTracks.length) {
      displayStream.getTracks().forEach((track) => track.stop());
      displayStreamRef.current = null;
      throw new Error("No meeting audio was shared");
    }
    audioTracks.forEach((track) => {
      track.addEventListener("ended", () => {
        if (keepRecordingRef.current) stopRecording();
      });
    });
    return new MediaStream(audioTracks);
  }

  async function openLocalMediaAudioStream() {
    const media = localMediaRef.current;
    if (!media || !localMediaUrl) throw new Error("Choose a local media file first");
    await waitForMediaReady(media);
    if (media.paused) await media.play();
    const captured = captureStreamFromMedia(media);
    if (!captured) throw new Error("This browser cannot capture local media playback");
    const audioTracks = captured.getAudioTracks();
    if (!audioTracks.length) throw new Error("This media file has no readable audio track");
    return new MediaStream(audioTracks);
  }

  async function openCaptureStream() {
    const source = inputSourceRef.current;
    if (source === "meeting") return openMeetingAudioStream();
    if (source === "file") return openLocalMediaAudioStream();
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
      }
    });
  }

  function clearActiveSession() {
    const session = activeSession;
    if (!session) return;
    if (recording) {
      setEngineMessage("Stop recording before clearing text");
      return;
    }
    if (session.segments.length && !window.confirm("Clear the current transcript? Saved cloud notes stay unchanged.")) return;
    resetLiveDraft();
    clipIndexRef.current = 1;
    updateActiveSession((item) => ({
      ...item,
      segments: [],
      endedAt: undefined,
      lastSavedAt: undefined,
      updatedAt: new Date().toISOString()
    }));
    setEngineMessage("Transcript cleared");
  }

  function setupMeter(stream: MediaStream) {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return;
    const audioContext = new AudioContextCtor();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    const data = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    audioContextRef.current = audioContext;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const level = Math.min(100, Math.round(Math.sqrt(sum / data.length) * 190));
      cloudVoicePeakRef.current = Math.max(cloudVoicePeakRef.current, level);
      setMicLevel(level);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  async function startRecording() {
    if (recording) return;
    const session = ensureActiveSession();
    clipIndexRef.current = Math.max(1, session.segments.length + 1);
    resetLiveDraft();
    const source = inputSourceRef.current;
    setEngineMessage(source === "meeting" ? "Opening audio picker" : source === "file" ? "Starting media playback" : "Requesting microphone");

    try {
      if (source !== "mic" && !aiStatus.configured) {
        throw new Error("Smart AI is required for meeting and media audio");
      }
      const stream = await openCaptureStream();
      if (!stream.getAudioTracks().length) throw new Error("No audio track found");
      streamRef.current = stream;
      keepRecordingRef.current = true;
      setupMeter(stream);

      const cloudOnlySource = source !== "mic";
      const smartCloud = (mode === "smart" || cloudOnlySource) && aiStatus.configured;
      let liveDraftStarted = false;

      if (smartCloud) {
        if (typeof MediaRecorder === "undefined") throw new Error("This browser cannot create audio segments for Smart mode");
        startCloudSegmentRecorder(stream);
        if (source === "mic") liveDraftStarted = startBrowserRecognition(true);
      } else {
        liveDraftStarted = startBrowserRecognition(false);
      }

      setRecording(true);
      setEngineMessage(
        smartCloud
          ? source === "mic" && liveDraftStarted
            ? "Live draft + cloud refine"
            : `${captureSourceLabel(source)} audio + cloud refine`
          : liveDraftStarted
            ? "Browser listening"
            : "Browser capture unavailable"
      );
    } catch (error) {
      setEngineMessage(error instanceof Error ? error.message : "Cannot start microphone");
      cleanupRecording();
    }
  }

  function startBrowserRecognition(draftOnly = false) {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) {
      setEngineMessage("Browser speech recognition is not available in this browser");
      return false;
    }
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    const selectedSpeechLang = speechLangRef.current;
    if (selectedSpeechLang !== "auto") recognition.lang = selectedSpeechLang;

    recognition.onresult = (event: any) => {
      let finalText = "";
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const text = event.results[index][0]?.transcript || "";
        if (event.results[index].isFinal) finalText += text;
        else interim += text;
      }
      if (draftOnly) {
        updateLiveDraft(finalText.trim(), interim.trim());
        return;
      }
      setInterimTranscript(interim.trim());
      if (finalText.trim()) void processBrowserText(finalText.trim());
    };
    recognition.onerror = (event: any) => {
      if (draftOnly) {
        setEngineMessage(event.error ? `Live draft paused: ${event.error}` : "Live draft paused");
      } else {
        setEngineMessage(event.error ? `Speech engine: ${event.error}` : "Speech engine paused");
      }
    };
    recognition.onend = () => {
      if (!keepRecordingRef.current) return;
      window.setTimeout(() => {
        try {
          recognition.start();
        } catch {
          // The browser may still be closing the previous recognition session.
        }
      }, 350);
    };

    try {
      recognition.start();
      return true;
    } catch {
      setEngineMessage("Speech engine could not start");
      return false;
    }
  }

  async function processBrowserText(text: string) {
    const id = uid("seg");
    const now = new Date().toISOString();
    const currentTargetLang = targetLangRef.current;
    let translatedText = "";
    let sourceText = text;
    let sourceLang = speechLangRef.current === "auto" ? "auto" : speechLangRef.current.split("-")[0];
    const context = recentSegmentContext();

    if (aiStatus.configured) {
      try {
        const res = await fetch("/api/smart-transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            sourceLang,
            targetLang: currentTargetLang,
            meetingTitle: context.meetingTitle,
            sourceContext: context.sourceContext,
            translationContext: context.translationContext
          })
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || "Translation failed");
        sourceText = payload.sourceText || text;
        translatedText = payload.translatedText || "";
        sourceLang = payload.sourceLang || sourceLang;
      } catch (error) {
        translatedText = "";
        setEngineMessage(error instanceof Error ? error.message : "Translation failed");
      }
    }

    addSegment({
      id,
      clipIndex: clipIndexRef.current++,
      startedAt: now,
      endedAt: now,
      sourceText,
      translatedText,
      sourceLang,
      targetLang: currentTargetLang,
      captureSource: inputSourceRef.current,
      origin: "browser",
      status: "ready"
    });
  }

  function startCloudSegmentRecorder(stream: MediaStream) {
    if (!keepRecordingRef.current || typeof MediaRecorder === "undefined") return;

    const clipIndex = clipIndexRef.current;
    clipIndexRef.current += 1;
    const startedAt = new Date().toISOString();
    const chunks: Blob[] = [];
    const recorder = createSpeechRecorder(stream);
    cloudVoicePeakRef.current = 0;
    cloudRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };

    recorder.onstop = () => {
      if (cloudSegmentTimerRef.current) window.clearTimeout(cloudSegmentTimerRef.current);
      cloudSegmentTimerRef.current = null;
      if (cloudRecorderRef.current === recorder) cloudRecorderRef.current = null;

      const endedAt = new Date().toISOString();
      const elapsed = new Date(endedAt).getTime() - new Date(startedAt).getTime();
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const voicePeak = cloudVoicePeakRef.current;
      if (blob.size >= MIN_CLOUD_AUDIO_BYTES && elapsed >= 1200 && voicePeak >= MIN_VOICE_LEVEL) {
        void processCloudChunk(blob, clipIndex, startedAt, endedAt);
      } else if (keepRecordingRef.current) {
        setEngineMessage(voicePeak < MIN_VOICE_LEVEL ? "Listening for clear speech" : "Listening");
      }

      if (keepRecordingRef.current && stream.active) {
        window.setTimeout(() => startCloudSegmentRecorder(stream), CLOUD_RESTART_MS);
      }
    };

    recorder.start();
    cloudSegmentTimerRef.current = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, CHUNK_MS);
  }

  async function processCloudChunk(blob: Blob, clipIndex: number, startedAt: string, endedAt: string) {
    const id = uid("seg");
    const currentTargetLang = targetLangRef.current;
    const currentSpeechLang = speechLangRef.current;
    const context = recentSegmentContext();
    const draftAtRequest = browserDraftRef.current;
    setEngineMessage("Processing speech");

    try {
      const form = new FormData();
      form.append("file", blob, `clip-${clipIndex}.webm`);
      form.append("targetLang", currentTargetLang);
      form.append("sourceLang", currentSpeechLang === "auto" ? "auto" : currentSpeechLang.split("-")[0]);
      form.append("meetingTitle", context.meetingTitle);
      form.append("sourceContext", context.sourceContext);
      form.append("translationContext", context.translationContext);
      const res = await fetch("/api/smart-transcribe", { method: "POST", body: form });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Smart Transcribe failed");
      if (payload.skipped) {
        if (browserDraftRef.current === draftAtRequest) resetLiveDraft();
        setEngineMessage(payload.reason || "Listening");
        return;
      }

      addSegment({
        id,
        clipIndex,
        startedAt,
        endedAt,
        sourceText: payload.sourceText || "",
        translatedText: payload.translatedText || "",
        sourceLang: payload.sourceLang || "auto",
        targetLang: payload.targetLang || currentTargetLang,
        captureSource: inputSourceRef.current,
        origin: "cloud",
        status: "ready"
      });
      if (browserDraftRef.current === draftAtRequest) resetLiveDraft();
      setEngineMessage("Text updated");
    } catch (error) {
      addSegment({
        id,
        clipIndex,
        startedAt,
        endedAt,
        sourceText: "",
        translatedText: "",
        sourceLang: "auto",
        targetLang: currentTargetLang,
        captureSource: inputSourceRef.current,
        origin: "cloud",
        status: "error",
        error: error instanceof Error ? error.message : "Smart Transcribe failed"
      });
      setEngineMessage(error instanceof Error ? error.message : "Smart Transcribe failed");
    }
  }

  function stopRecording() {
    keepRecordingRef.current = false;
    setRecording(false);
    setEngineMessage("Stopping");
    resetLiveDraft();
    if (inputSourceRef.current === "file") localMediaRef.current?.pause();
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // Ignore browser recognition shutdown races.
    }
    try {
      if (cloudSegmentTimerRef.current) window.clearTimeout(cloudSegmentTimerRef.current);
      cloudSegmentTimerRef.current = null;
      if (cloudRecorderRef.current && cloudRecorderRef.current.state !== "inactive") {
        cloudRecorderRef.current.stop();
      }
    } catch {
      // Ignore recorder shutdown races.
    }
    window.setTimeout(cleanupRecording, 1200);
    updateActiveSession((session) => ({
      ...session,
      endedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    setEngineMessage("Recording stopped");
  }

  function cleanupRecording() {
    if (cloudSegmentTimerRef.current) window.clearTimeout(cloudSegmentTimerRef.current);
    cloudSegmentTimerRef.current = null;
    cloudRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current = null;
    recognitionRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    cloudVoicePeakRef.current = 0;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setMicLevel(0);
  }

  async function saveActiveSession() {
    const session = activeSession;
    if (!session) return;
    const savedAt = new Date().toISOString();
    updateActiveSession((item) => item.id === session.id ? { ...item, lastSavedAt: savedAt, updatedAt: savedAt } : item);

    if (!dbEnabled) {
      setStorageMessage("Saved locally in this browser");
      return;
    }

    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberName: userName || "Personal",
          note: {
            date: session.date,
            member_name: userName || "Personal",
            note_type: "transcript" as const,
            title: `Meeting - ${session.title}`,
            content: sessionMarkdown(session),
            visibility: "private" as const,
            source: "lmn-smart-transcribe",
            recordingSessionId: session.id
          }
        })
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Save failed");
      setStorageMessage("Saved text to Cloudflare");
      void refreshSavedNotes();
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : "Save failed; local copy kept");
    }
  }

  function downloadTranscript(session = activeSession) {
    if (!session) return;
    downloadText(`${safeFilename(session.title)}.md`, sessionMarkdown(session), "text/markdown;charset=utf-8");
  }

  function downloadJson(session = activeSession) {
    if (!session) return;
    downloadText(`${safeFilename(session.title)}.json`, JSON.stringify(session, null, 2), "application/json;charset=utf-8");
  }

  function deleteSession(sessionId: string) {
    setSessions((prev) => {
      const next = prev.filter((session) => session.id !== sessionId);
      sessionsRef.current = next;
      return next;
    });
    if (activeSessionId === sessionId) setActiveSessionId("");
  }

  const sourceText = sortedSegments.map((segment) => segment.sourceText).filter(Boolean).join("\n\n");
  const translatedText = sortedSegments.map((segment) => segment.translatedText).filter(Boolean).join("\n\n");
  const cloudReady = (mode === "smart" || inputSource !== "mic") && aiStatus.configured;

  return (
    <>
      <header className="app-header">
        <div className="container header-grid">
          <div>
            <p className="eyebrow">Personal LMN</p>
            <h1>Live Meeting Notes</h1>
            <p className="header-sub">Record, transcribe, translate, and keep a clean bilingual memory of every conversation.</p>
          </div>
          <div className="status-strip">
            <span className={aiStatus.configured ? "status-dot green" : "status-dot amber"} />
            <div>
              <strong>{aiStatus.configured ? "Smart Transcribe ready" : "Free browser mode"}</strong>
              <small>{aiStatus.configured ? "Meaning-first bilingual notes" : "Cloud AI keys not set"}</small>
            </div>
          </div>
        </div>
      </header>

      <main className="container workspace">
        <section className="control-panel">
          <div className="section-head">
            <span>Session</span>
            <strong>{recording ? "Live" : "Idle"}</strong>
          </div>

          <label className="field">
            <span>Your name</span>
            <input value={userName} onChange={(event) => setUserName(event.target.value)} />
          </label>

          <label className="field">
            <span>Meeting title</span>
            <input
              value={activeSession?.title || ""}
              onChange={(event) => updateActiveSession((session) => ({ ...session, title: event.target.value, updatedAt: new Date().toISOString() }))}
              onFocus={ensureActiveSession}
              placeholder="Create or name a meeting"
            />
          </label>

          <div className="source-panel">
            <div className="panel-label">Source</div>
            <div className="source-switch" role="group" aria-label="Audio source">
              {CAPTURE_SOURCES.map((source) => (
                <button
                  className={inputSource === source.value ? "active" : ""}
                  disabled={recording}
                  key={source.value}
                  onClick={() => changeInputSource(source.value)}
                  type="button"
                >
                  <span>{source.label}</span>
                  <small>{source.short}</small>
                </button>
              ))}
            </div>
            {inputSource === "meeting" && (
              <div className="source-hint">
                <strong>Browser share audio</strong>
                <span>Chrome or Edge works best for tab and system audio.</span>
              </div>
            )}
            {inputSource === "file" && (
              <div className="file-deck">
                <input
                  accept="audio/*,video/*"
                  hidden
                  onChange={(event) => handleLocalMediaFile(event.target.files?.[0])}
                  ref={fileInputRef}
                  type="file"
                />
                <button className="file-button" disabled={recording} onClick={() => fileInputRef.current?.click()} type="button">
                  Choose media
                </button>
                {localMediaUrl ? (
                  <div className="media-preview">
                    <strong>{localMediaName}</strong>
                    {localMediaKind === "video" ? (
                      <video controls ref={(node) => { localMediaRef.current = node; }} src={localMediaUrl} onEnded={() => recording && stopRecording()} />
                    ) : (
                      <audio controls ref={(node) => { localMediaRef.current = node; }} src={localMediaUrl} onEnded={() => recording && stopRecording()} />
                    )}
                  </div>
                ) : (
                  <span className="source-empty">No local media selected</span>
                )}
              </div>
            )}
          </div>

          <div className="mode-switch" role="group" aria-label="Transcription mode">
            <button className={mode === "smart" ? "active" : ""} onClick={() => setMode("smart")} type="button">Smart AI</button>
            <button
              className={mode === "browser" ? "active" : ""}
              disabled={inputSource !== "mic"}
              onClick={() => setMode("browser")}
              type="button"
            >
              Browser
            </button>
          </div>

          <div className="record-row">
            <button className={recording ? "record-button stop" : "record-button"} onClick={recording ? stopRecording : startRecording} type="button">
              {recording ? "Stop" : inputSource === "file" ? "Play + transcribe" : inputSource === "meeting" ? "Capture audio" : "Record"}
            </button>
            <button className="icon-button" onClick={createFreshSession} type="button" title="New meeting">New</button>
          </div>

          <div className="meter-card">
            <div className="meter-label">
              <span>{captureSourceLabel(inputSource)}</span>
              <strong>{micLevel}%</strong>
            </div>
            <div className="meter"><span style={{ width: `${micLevel}%` }} /></div>
          </div>

          <div className="mini-log">
            <span>{engineMessage}</span>
            <span>{storageMessage}</span>
            <span>{cloudReady ? `${captureSourceLabel(inputSource)} to text memory` : "Local browser capture"}</span>
          </div>

          <div className="action-grid">
            <button onClick={saveActiveSession} type="button">Save text</button>
            <button onClick={clearActiveSession} type="button">Clear</button>
            <button onClick={() => downloadTranscript()} type="button">Markdown</button>
            <button onClick={() => setShowDetails((value) => !value)} type="button">{showDetails ? "Hide details" : "Details"}</button>
          </div>
        </section>

        <section className="live-board">
          <div className="infographic">
            <div className="pulse-ring">
              <span>{recording ? "Live" : "Ready"}</span>
            </div>
            <div className="metric-grid">
              <div><small>Minutes</small><strong>{stats.minutes}</strong></div>
              <div><small>Parts</small><strong>{stats.segments}</strong></div>
              <div><small>Original</small><strong>{stats.sourceWords}</strong></div>
              <div><small>Translation</small><strong>{stats.translatedWords}</strong></div>
            </div>
          </div>

          <div className="transcript-grid">
            <article className="transcript-pane">
              <div className="pane-head pane-head-control">
                <span>Original</span>
                <select value={speechLang} onChange={(event) => changeSpeechLanguage(event.target.value)} aria-label="Speaker language">
                  {SPEECH_LANGUAGES.map((item) => <option value={item.code} key={item.code}>{item.label}</option>)}
                </select>
              </div>
              <div className="transcript-text">
                {sourceText || <span className="placeholder">Waiting for speech...</span>}
                {interimTranscript && <p className="interim">{interimTranscript}</p>}
              </div>
            </article>

            <article className="transcript-pane native">
              <div className="pane-head pane-head-control">
                <span>Translate to</span>
                <select value={targetLang} onChange={(event) => changeTargetLanguage(event.target.value)} aria-label="Translation language">
                  {NATIVE_LANGUAGES.map((item) => <option value={item.code} key={item.code}>{item.label}</option>)}
                </select>
              </div>
              <div className="transcript-text">
                {translatedText || <span className="placeholder">{aiStatus.configured ? "Translation will appear after speech is processed." : "Add Cloudflare AI keys for translation."}</span>}
              </div>
            </article>
          </div>

          {showDetails && (
            <div className="timeline">
              {sortedSegments.length ? sortedSegments.map((segment) => (
                <article className={`timeline-item ${segment.status}`} key={segment.id}>
                  <time>{displayTime(segment.endedAt)}</time>
                  <div>
                    <strong>Part {segment.clipIndex} - {captureSourceLabel(segment.captureSource || "mic")} - {segment.sourceLang} to {segment.targetLang}</strong>
                    {segment.error ? <p className="error-text">{segment.error}</p> : <p>{segment.sourceText || "No source text"}</p>}
                    {segment.translatedText && <p className="translation-line">{segment.translatedText}</p>}
                  </div>
                </article>
              )) : (
                <div className="empty-timeline">No details in this meeting yet.</div>
              )}
            </div>
          )}
        </section>

        <aside className="memory-panel">
          <div className="section-head">
            <span>Memory</span>
            <strong>{sessions.length}</strong>
          </div>

          <div className="saved-list">
            {sessions.length ? sessions.map((session) => (
              <article className={session.id === activeSession?.id ? "saved-item active" : "saved-item"} key={session.id}>
                <button onClick={() => setActiveSessionId(session.id)} type="button">
                  <strong>{session.title}</strong>
                  <span>{session.date} - {session.segments.length} text parts</span>
                </button>
                <div>
                  <button onClick={() => downloadTranscript(session)} type="button">MD</button>
                  <button onClick={() => deleteSession(session.id)} type="button">Del</button>
                </div>
              </article>
            )) : <p className="muted">Create a meeting to start.</p>}
          </div>

          <div className="cloud-box">
            <div className="section-head compact">
              <span>Today in DB</span>
              <strong>{dbEnabled ? cloudNotes.length : 0}</strong>
            </div>
            {dbEnabled ? (
              <div className="saved-list compact-list">
                {cloudNotes.length ? cloudNotes.map((note) => (
                  <article className="db-note" key={note.id || note.title}>
                    <strong>{note.title}</strong>
                    <span>{note.updated_at ? new Date(note.updated_at).toLocaleString() : note.date}</span>
                    <button onClick={() => downloadText(`${safeFilename(note.title)}.md`, note.content || "", "text/markdown;charset=utf-8")} type="button">Download</button>
                  </article>
                )) : <p className="muted">No saved DB notes today.</p>}
              </div>
            ) : <p className="muted">Local mode is active.</p>}
          </div>
        </aside>
      </main>
    </>
  );
}
