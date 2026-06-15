import { NextRequest, NextResponse } from "next/server";
import { getD1, getWorkspaceCode, logActivity, nowIso, rowToStudyNote, uid } from "../../../lib/cloudflare";

async function findNote(id: string) {
  const db = getD1();
  if (!db) return null;
  return db
    .prepare(
      `select id, date, member_name, note_type, title, content, visibility, created_at, updated_at
       from study_notes
       where id = ? and workspace_code = ?`
    )
    .bind(id, getWorkspaceCode())
    .first<Record<string, unknown>>();
}

export async function POST(req: NextRequest) {
  try {
    const db = getD1();
    if (!db) return NextResponse.json({ error: "Cloudflare D1 is not configured" }, { status: 503 });
    const body = await req.json();
    const { memberName, note } = body;
    if (!memberName || !note?.date || !note?.title) return NextResponse.json({ error: "Missing memberName, date or title" }, { status: 400 });

    const id = note.id || uid("note");
    const workspaceCode = getWorkspaceCode();
    const timestamp = nowIso();
    const noteType = note.note_type || "class";
    const visibility = note.visibility || "team";

    if (note.id) {
      await db
        .prepare(
          `update study_notes
           set date = ?, member_name = ?, note_type = ?, title = ?, content = ?, visibility = ?, updated_at = ?
           where id = ? and workspace_code = ?`
        )
        .bind(note.date, memberName, noteType, note.title, note.content || "", visibility, timestamp, id, workspaceCode)
        .run();
    } else {
      await db
        .prepare(
          `insert into study_notes
            (id, workspace_code, date, member_name, note_type, title, content, visibility, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, workspaceCode, note.date, memberName, noteType, note.title, note.content || "", visibility, timestamp, timestamp)
        .run();
    }

    const saved = await findNote(id);
    if (!saved) return NextResponse.json({ error: "Note was not saved" }, { status: 500 });
    const recordingSessionId = note.recordingSessionId || String(note.content || "").match(/Recording session:\s*(.+)/)?.[1]?.trim() || null;
    const deviceId = note.deviceId || String(note.content || "").match(/Device:\s*(.+)/)?.[1]?.trim() || null;
    await logActivity(memberName, note.id ? "update_note" : "create_note", "study_note", id, {
      date: note.date,
      title: note.title,
      type: note.note_type,
      source: note.source || "manual",
      recordingSessionId,
      deviceId,
      chunkId: note.chunkId || null,
      chunk: note.chunk || null
    });
    return NextResponse.json({ note: rowToStudyNote(saved) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const db = getD1();
    if (!db) return NextResponse.json({ error: "Cloudflare D1 is not configured" }, { status: 503 });
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const memberName = searchParams.get("memberName") || "unknown";
    if (!id) return NextResponse.json({ error: "Missing note id" }, { status: 400 });
    await db.prepare("delete from study_notes where workspace_code = ? and id = ?").bind(getWorkspaceCode(), id).run();
    await logActivity(memberName, "delete_note", "study_note", id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
