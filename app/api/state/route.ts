import { NextRequest, NextResponse } from "next/server";
import { getD1, getWorkspaceCode, rowToStudyNote, storageConfigured } from "../../../lib/cloudflare";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const err = error as { message?: string; details?: string; hint?: string; code?: string };
    return [err.message, err.details, err.hint, err.code].filter(Boolean).join(" ");
  }
  return String(error || "unknown error");
}

export async function GET(req: NextRequest) {
  const date = new URL(req.url).searchParams.get("date") || todayIso();

  const db = getD1();
  if (!db) {
    return NextResponse.json(
      {
        dbEnabled: false,
        message: "Cloudflare D1 binding is not configured. App is running in local browser mode.",
        workspaceCode: getWorkspaceCode(),
        notes: [],
        logs: []
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const workspaceCode = getWorkspaceCode();
    const notesRes = await db
      .prepare(
        `select id, date, member_name, note_type, title, content, visibility, created_at, updated_at
         from study_notes
         where workspace_code = ? and date = ?
         order by updated_at desc`
      )
      .bind(workspaceCode, date)
      .all<Record<string, unknown>>();

    return NextResponse.json(
      {
        dbEnabled: storageConfigured(),
        workspaceCode,
        notes: (notesRes.results || []).map(rowToStudyNote),
        logs: []
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        dbEnabled: false,
        message: `Cloudflare D1 is configured but not readable yet (${errorMessage(error)}). App is running in local browser mode.`,
        workspaceCode: getWorkspaceCode(),
        notes: [],
        logs: []
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
