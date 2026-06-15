import { NextResponse } from "next/server";

const DISABLED_RESPONSE = {
  error: "Audio storage is disabled. Live Meeting Notes stores transcript text only.",
  storage: "text-only"
};

export async function POST() {
  return NextResponse.json(DISABLED_RESPONSE, { status: 410 });
}

export async function GET() {
  return NextResponse.json(DISABLED_RESPONSE, { status: 410 });
}
