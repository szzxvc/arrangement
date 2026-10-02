export interface User {
  id: string;
  username: string;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  creatorId: string;
  creatorUsername: string;
  memberCount: number;
  createdAt: number;
}
export interface Member extends User {
  joinedAt: number;
  version: number;
  workSessionId: string | null;
  startedAt: number | null;
}
export interface Invitation {
  id: string;
  projectId: string;
  projectName: string;
  inviterUsername: string;
  createdAt: number;
}
export interface Reservation {
  id: string;
  userId: string;
  username: string;
  startAt: number;
  endAt: number;
  status: 'active' | 'cancelled';
  createdAt: number;
  cancelledAt: number | null;
}
export interface Activity {
  id: string;
  actorUsername: string;
  targetUsername: string;
  fromState: 'resting' | 'working';
  toState: 'resting' | 'working';
  reason: 'self' | 'forced';
  workSessionId: string;
  occurredAt: number;
}
export interface Page<T> {
  items: T[];
  page: number;
  hasMore: boolean;
}
export interface Snapshot {
  project: Project;
  members: Member[];
  reservations: Reservation[];
  reservationsHasMore: boolean;
  activity: Activity[];
  serverNow: number;
}
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
