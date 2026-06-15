-- Live Meeting Notes schema for Cloudflare D1.
-- Run with:
-- npx wrangler d1 execute live-meeting-notes-db --remote --file=./db/schema.sql

create table if not exists study_notes (
  id text primary key,
  workspace_code text not null,
  date text not null,
  member_name text not null,
  note_type text not null check (note_type in ('class', 'vocabulary', 'action', 'transcript', 'reflection')),
  title text not null,
  content text not null default '',
  visibility text not null default 'private' check (visibility in ('team', 'private')),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists study_notes_workspace_date_idx
  on study_notes(workspace_code, date, updated_at desc);

create table if not exists activity_logs (
  id text primary key,
  workspace_code text not null,
  member_name text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  payload text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists activity_logs_workspace_created_idx
  on activity_logs(workspace_code, created_at desc);
