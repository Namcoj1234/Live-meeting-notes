import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ActivityLog, StudyNote } from "./types";

type D1Result<T> = {
  results?: T[];
  success?: boolean;
  error?: string;
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
};

type D1Database = {
  prepare(query: string): D1PreparedStatement;
};

type R2Object = {
  body: ReadableStream;
  httpEtag?: string;
  size?: number;
  uploaded?: Date;
  writeHttpMetadata(headers: Headers): void;
};

type R2Bucket = {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }
  ): Promise<R2Object | null>;
  get(key: string): Promise<R2Object | null>;
};

type KVNamespace = {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { metadata?: Record<string, string> }
  ): Promise<void>;
  get(key: string, type: "stream"): Promise<ReadableStream | null>;
  getWithMetadata<T = Record<string, string>>(
    key: string,
    type: "stream"
  ): Promise<{ value: ReadableStream | null; metadata: T | null }>;
};

type AiBinding = {
  run(model: string, input: unknown): Promise<unknown>;
};

type CloudflareEnv = {
  LMN_DB?: D1Database;
  LMN_AUDIO?: R2Bucket;
  LMN_AUDIO_KV?: KVNamespace;
  AI?: AiBinding;
  WORKSPACE_CODE?: string;
};

export function getWorkspaceCode() {
  return process.env.WORKSPACE_CODE || getCloudflareEnv()?.WORKSPACE_CODE || "LMN-PERSONAL";
}

export function getCloudflareEnv(): CloudflareEnv | null {
  try {
    return getCloudflareContext().env as CloudflareEnv;
  } catch {
    return null;
  }
}

export function getD1() {
  return getCloudflareEnv()?.LMN_DB || null;
}

export function getAudioBucket() {
  return getCloudflareEnv()?.LMN_AUDIO || null;
}

export function getAudioKvNamespace() {
  return getCloudflareEnv()?.LMN_AUDIO_KV || null;
}

export function getAiBinding() {
  return getCloudflareEnv()?.AI || null;
}

export function storageConfigured() {
  const env = getCloudflareEnv();
  return Boolean(env?.LMN_DB);
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function rowToStudyNote(row: Record<string, unknown>): StudyNote {
  return {
    id: String(row.id || ""),
    date: String(row.date || ""),
    member_name: String(row.member_name || ""),
    note_type: (String(row.note_type || "transcript") as StudyNote["note_type"]),
    title: String(row.title || ""),
    content: String(row.content || ""),
    visibility: (String(row.visibility || "private") as StudyNote["visibility"]),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || "")
  };
}

export function rowToActivityLog(row: Record<string, unknown>): ActivityLog {
  return {
    id: String(row.id || ""),
    member_name: String(row.member_name || ""),
    action: String(row.action || ""),
    entity_type: String(row.entity_type || ""),
    entity_id: row.entity_id ? String(row.entity_id) : undefined,
    payload: typeof row.payload === "string" ? safeJson(row.payload) : undefined,
    created_at: String(row.created_at || "")
  };
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function logActivity(
  memberName: string,
  action: string,
  entityType: string,
  entityId?: string,
  payload: Record<string, unknown> = {}
) {
  const db = getD1();
  if (!db) return;
  await db
    .prepare(
      `insert into activity_logs
        (id, workspace_code, member_name, action, entity_type, entity_id, payload, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      uid("log"),
      getWorkspaceCode(),
      memberName || "Personal",
      action,
      entityType,
      entityId || null,
      JSON.stringify(payload),
      nowIso()
    )
    .run();
}
