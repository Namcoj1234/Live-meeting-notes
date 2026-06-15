import { NextRequest, NextResponse } from "next/server";
import {
  getAudioBucket,
  getAudioKvNamespace,
  getD1,
  getWorkspaceCode,
  logActivity,
  nowIso,
  rowToStudyNote,
  uid
} from "../../../lib/cloudflare";

function safePathPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "unknown";
}

function audioUrl(req: NextRequest, path: string) {
  return `${req.nextUrl.origin}/api/audio?path=${encodeURIComponent(path)}`;
}

function normalAudioType(value: string) {
  const type = value.toLowerCase();
  if (type.includes("ogg")) return "audio/ogg";
  if (type.includes("mp4")) return "audio/mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return "audio/mpeg";
  if (type.includes("wav")) return "audio/wav";
  return "audio/webm";
}

function contentTypeFromPath(path: string) {
  const name = path.toLowerCase();
  if (name.endsWith(".ogg")) return "audio/ogg";
  if (name.endsWith(".m4a") || name.endsWith(".mp4")) return "audio/mp4";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".wav")) return "audio/wav";
  return "audio/webm";
}

export async function POST(req: NextRequest) {
  try {
    const db = getD1();
    const bucket = getAudioBucket();
    const kv = getAudioKvNamespace();
    if (!db || (!bucket && !kv)) return NextResponse.json({ error: "Cloudflare D1/audio storage is not configured" }, { status: 503 });

    const form = await req.formData();
    const file = form.get("file");
    const memberName = String(form.get("memberName") || "").trim();
    const date = String(form.get("date") || "").trim();
    const sessionId = String(form.get("sessionId") || "").trim();
    const deviceId = String(form.get("deviceId") || "unknown-device").trim();
    const chunkId = String(form.get("chunkId") || "").trim();
    const focus = String(form.get("focus") || "").trim();
    const startedAt = String(form.get("startedAt") || "").trim();
    const endedAt = String(form.get("endedAt") || "").trim();
    const clipIndex = String(form.get("clipIndex") || "").trim();
    if (!(file instanceof File)) return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
    if (!memberName || !date || !sessionId || !chunkId) return NextResponse.json({ error: "Missing memberName, date, sessionId or chunkId" }, { status: 400 });

    const contentType = normalAudioType(file.type || "audio/webm");
    const ext = contentType.includes("ogg") ? "ogg" : contentType.includes("mp4") ? "m4a" : contentType.includes("mpeg") ? "mp3" : contentType.includes("wav") ? "wav" : "webm";
    const path = [
      safePathPart(getWorkspaceCode()),
      safePathPart(date),
      safePathPart(memberName),
      safePathPart(sessionId),
      `${safePathPart(chunkId)}.${ext}`
    ].join("/");
    const bytes = await file.arrayBuffer();
    if (bucket) {
      await bucket.put(path, bytes, {
        httpMetadata: { contentType },
        customMetadata: {
          workspaceCode: getWorkspaceCode(),
          memberName,
          sessionId,
          chunkId
        }
      });
    } else if (kv) {
      await kv.put(path, bytes, {
        metadata: {
          contentType,
          workspaceCode: getWorkspaceCode(),
          memberName,
          sessionId,
          chunkId
        }
      });
    }

    const noteContent = [
      `User: ${memberName}`,
      `Recording session: ${sessionId}`,
      `Device: ${deviceId}`,
      `Date: ${date}`,
      focus ? `Focus: ${focus}` : "",
      `Audio chunk: ${clipIndex || "1"}`,
      `Audio chunk ID: ${chunkId}`,
      startedAt ? `Started: ${new Date(startedAt).toLocaleString()}` : "",
      endedAt ? `Saved: ${new Date(endedAt).toLocaleString()}` : "",
      `Audio type: ${contentType}`,
      `Audio bytes: ${file.size}`,
      `Audio path: ${path}`,
      `Audio URL: ${audioUrl(req, path)}`,
      "",
      "Audio recording checkpoint."
    ].filter(Boolean).join("\n");

    const noteId = uid("note");
    const timestamp = nowIso();
    await db
      .prepare(
        `insert into study_notes
          (id, workspace_code, date, member_name, note_type, title, content, visibility, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        noteId,
        getWorkspaceCode(),
        date,
        memberName,
        "transcript",
        `Audio recording - ${date} - ${memberName} - ${sessionId.slice(-8)} - clip ${clipIndex || "1"}`,
        noteContent,
        "team",
        timestamp,
        timestamp
      )
      .run();

    const note = await db
      .prepare(
        `select id, date, member_name, note_type, title, content, visibility, created_at, updated_at
         from study_notes
         where id = ? and workspace_code = ?`
      )
      .bind(noteId, getWorkspaceCode())
      .first<Record<string, unknown>>();
    if (!note) return NextResponse.json({ error: "Audio note was not saved" }, { status: 500 });

    await logActivity(memberName, "create_audio_clip", "study_note", noteId, {
      date,
      sessionId,
      deviceId,
      chunkId,
      path,
      bytes: file.size,
      contentType
    });

    return NextResponse.json({ note: rowToStudyNote(note), path, url: audioUrl(req, path) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const bucket = getAudioBucket();
    const kv = getAudioKvNamespace();
    if (!bucket && !kv) return NextResponse.json({ error: "Cloudflare audio storage is not configured" }, { status: 503 });
    const path = req.nextUrl.searchParams.get("path") || "";
    if (!path) return NextResponse.json({ error: "Missing audio path" }, { status: 400 });
    const headers = new Headers();
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("Content-Disposition", `inline; filename="${path.split("/").at(-1) || "audio.webm"}"`);

    if (bucket) {
      const object = await bucket.get(path);
      if (!object) return NextResponse.json({ error: "Audio file not found" }, { status: 404 });
      object.writeHttpMetadata(headers);
      if (object.httpEtag) headers.set("ETag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    if (kv) {
      const object = await kv.getWithMetadata<Record<string, string>>(path, "stream");
      if (!object.value) return NextResponse.json({ error: "Audio file not found" }, { status: 404 });
      headers.set("Content-Type", object.metadata?.contentType || contentTypeFromPath(path));
      return new Response(object.value, { headers });
    }

    return NextResponse.json({ error: "Audio file not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
