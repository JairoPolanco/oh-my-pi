/**
 * Session model (blueprint §7, Pi heritage).
 *
 * Sessions persist as a tree with id/parentId, enabling branching without
 * destroying original history. The kernel defines the seam; the coding-agent
 * session manager remains the implementation until Phase 2 wiring.
 */

/** Opaque session identifier. */
export type SessionId = string;

export interface SessionRef {
	id: SessionId;
	parentId?: SessionId;
}

/** Session store seam: load/save/fork. */
export interface SessionStore {
	load(id: SessionId): Promise<SessionRef | null>;
	save(session: SessionRef): Promise<void>;
	/** Branch a new session from an existing one. */
	fork(from: SessionId, parentId?: SessionId): Promise<SessionRef>;
}
