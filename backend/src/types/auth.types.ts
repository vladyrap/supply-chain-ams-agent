export type Role = "viewer" | "consultor" | "aprobador" | "admin";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  active: boolean;
  created_at: string;
}

export interface UserWithPasswordHash extends User {
  password_hash: string;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface AuthenticatedRequest {
  user: User;
  sessionId: string;
}
