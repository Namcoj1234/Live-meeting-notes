export type StudyNote = {
  id?: string;
  date: string;
  member_name: string;
  note_type: "class" | "vocabulary" | "action" | "transcript" | "reflection";
  title: string;
  content: string;
  visibility: "team" | "private";
  updated_at?: string;
  created_at?: string;
};

export type ActivityLog = {
  id?: string;
  member_name: string;
  action: string;
  entity_type: string;
  entity_id?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
};

export type AppStatePayload = {
  dbEnabled: boolean;
  message?: string;
  workspaceCode: string;
  notes: StudyNote[];
  logs: ActivityLog[];
};
