// Kysely 类型化数据库 schema（snake_case 列名）。
// 领域记录（camelCase）与数据库行（snake_case）的映射由各 Repository 的 toRecord 负责，
// 本文件仅声明数据库层的表/列形态。

export interface ProjectsTable {
  id: string;
  name: string;
  cwd: string;
  owner_key: string;
  created_at: number;
}

export interface SessionsTable {
  id: string;
  owner_key: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  pi_session_file: string | null;
  model_provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  system_prompt: string | null;
  capability_versions: string | null;
}

export interface IdempotencyTable {
  session_id: string;
  request_id: string;
  result: string;
  created_at: number;
}

export interface DatabaseSchema {
  projects: ProjectsTable;
  sessions: SessionsTable;
  idempotency: IdempotencyTable;
}
