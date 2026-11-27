export type SessionArtifactKind = 'file' | 'app' | 'link';

export type SessionArtifactRequest =
  | { operation: 'list' }
  | { operation: 'create'; kind: SessionArtifactKind; title: string; source: string }
  | { operation: 'revoke'; id: string };

export interface SessionArtifact {
  id: string;
  kind: SessionArtifactKind;
  title: string;
  url: string;
  expiresAt: number;
}

export const SESSION_ARTIFACT_ACTION_TIMEOUT_MS = 20_000;
