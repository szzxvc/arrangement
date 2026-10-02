PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  password_algorithm TEXT NOT NULL CHECK (password_algorithm = 'scrypt'),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_n INTEGER NOT NULL,
  password_r INTEGER NOT NULL,
  password_p INTEGER NOT NULL,
  password_keylen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_started INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  creator_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX members_by_user ON project_members(user_id, project_id);
CREATE TABLE project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL,
  invitee_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_operation_id TEXT,
  FOREIGN KEY (project_id, inviter_id) REFERENCES project_members(project_id, user_id),
  CHECK ((status = 'pending' AND resolved_at IS NULL) OR (status <> 'pending' AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_invitation ON project_invitations(project_id, invitee_id) WHERE status = 'pending';
CREATE INDEX invitations_by_invitee ON project_invitations(invitee_id, status, created_at);
CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  started_by TEXT NOT NULL,
  ended_by TEXT,
  start_reason TEXT NOT NULL CHECK (start_reason IN ('self', 'forced')),
  end_reason TEXT CHECK (end_reason IN ('self', 'forced')),
  start_operation_id TEXT NOT NULL UNIQUE,
  end_operation_id TEXT UNIQUE,
  FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id),
  FOREIGN KEY (project_id, started_by) REFERENCES project_members(project_id, user_id),
  FOREIGN KEY (project_id, ended_by) REFERENCES project_members(project_id, user_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL AND end_operation_id IS NULL)
    OR (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL AND end_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_worker_per_project ON work_sessions(project_id) WHERE ended_at IS NULL;
CREATE INDEX work_by_member ON work_sessions(project_id, user_id, started_at);
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_at INTEGER NOT NULL CHECK (start_at % 60 = 0),
  end_at INTEGER NOT NULL CHECK (end_at % 60 = 0 AND end_at - start_at >= 60),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancel_operation_id TEXT UNIQUE,
  FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id),
  CHECK ((status = 'active' AND cancelled_at IS NULL AND cancel_operation_id IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_operation_id IS NOT NULL))
);
CREATE INDEX reservations_by_project_time ON reservations(project_id, status, start_at, end_at);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  work_session_id TEXT NOT NULL REFERENCES work_sessions(id),
  from_state TEXT NOT NULL CHECK (from_state IN ('resting', 'working')),
  to_state TEXT NOT NULL CHECK (to_state IN ('resting', 'working')),
  reason TEXT NOT NULL CHECK (reason IN ('self', 'forced')),
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (project_id, actor_id) REFERENCES project_members(project_id, user_id),
  FOREIGN KEY (project_id, target_id) REFERENCES project_members(project_id, user_id),
  CHECK (from_state <> to_state)
);
CREATE INDEX audit_by_project ON audit_events(project_id, occurred_at DESC, id);
CREATE TABLE mutation_requests (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT mutation_guard CHECK (guard = 1),
  PRIMARY KEY (user_id, request_id)
);

CREATE TRIGGER reservation_overlap_insert
BEFORE INSERT ON reservations
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_CONFLICT')
  WHERE EXISTS (SELECT 1 FROM reservations r WHERE r.project_id = NEW.project_id
    AND r.status = 'active' AND NEW.start_at < r.end_at AND NEW.end_at > r.start_at);
END;

CREATE TRIGGER reservation_overlap_update
BEFORE UPDATE OF project_id, start_at, end_at, status ON reservations
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_CONFLICT')
  WHERE EXISTS (SELECT 1 FROM reservations r WHERE r.id <> NEW.id AND r.project_id = NEW.project_id
    AND r.status = 'active' AND NEW.start_at < r.end_at AND NEW.end_at > r.start_at);
END;

-- 审计和版本变化由真实工作变化触发；条件 UPDATE 零行不会生成假审计。
CREATE TRIGGER audit_work_start
AFTER INSERT ON work_sessions
BEGIN
  INSERT INTO audit_events (id, project_id, actor_id, target_id, work_session_id, from_state, to_state, reason, occurred_at)
  VALUES (NEW.start_operation_id, NEW.project_id, NEW.started_by, NEW.user_id, NEW.id, 'resting', 'working', NEW.start_reason, NEW.started_at);
  UPDATE project_members SET state_version = state_version + 1
  WHERE project_id = NEW.project_id AND user_id = NEW.user_id;
END;

CREATE TRIGGER audit_work_stop
AFTER UPDATE OF ended_at ON work_sessions
WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
BEGIN
  INSERT INTO audit_events (id, project_id, actor_id, target_id, work_session_id, from_state, to_state, reason, occurred_at)
  VALUES (NEW.end_operation_id, NEW.project_id, NEW.ended_by, NEW.user_id, NEW.id, 'working', 'resting', NEW.end_reason, NEW.ended_at);
  UPDATE project_members SET state_version = state_version + 1
  WHERE project_id = NEW.project_id AND user_id = NEW.user_id;
END;
