/**
 * Content-addressed artifact model (blueprint §8).
 *
 * Every significant output — file snapshot, command output, web result, test
 * report, patch, model response, context snapshot — is stored as an immutable
 * artifact identified by the hash of its bytes:
 *
 *     ArtifactID = hash(content)
 *
 * The store gives deduplication (identical bytes collapse to one id), rollback
 * (nothing is overwritten), stale-write detection (an id that no longer hashes
 * to its content is corrupt), and provenance for events to reference.
 */

/**
 * Digest algorithm. BLAKE2b-256 is a NATIVE Bun primitive (verified against
 * `Bun.CryptoHasher.algorithms`) — not a portable Node fallback. The
 * content-addressed identity layer must not depend on an algorithm alias
 * that standard Node's `node:crypto` lacks, so the hash goes through Bun's
 * guaranteed primitive with an explicit availability assertion (paste-5 P0).
 */
export type HashAlgorithm = "blake2b256";

/** Content hash of an artifact's bytes, hex-encoded. */
export type ArtifactId = string;

/** Reference to an artifact, the currency events carry (blueprint §8). */
export interface ArtifactRef {
	/** Content-addressed id. */
	id: ArtifactId;
	/** Human-readable kind, e.g. "tool-output", "patch", "test-report". */
	kind?: string;
}

/** Immutable artifact record. */
export interface ArtifactRecord extends ArtifactRef {
	bytes: number;
	createdAt: number;
	algorithm: HashAlgorithm;
}

export interface ArtifactMetadata {
	kind?: string;
}

/**
 * The hash primitive backing the constitutional artifact identity layer.
 * Verified at module load: if the runtime lacks blake2b256 (e.g. a bare
 * Node embedding), fail loudly NOW rather than minting artifacts under a
 * silently broken digest.
 */
function artifactHasher(): Bun.CryptoHasher {
	if (!Bun.CryptoHasher.algorithms.includes("blake2b256")) {
		throw new Error("artifact store requires blake2b256, which the runtime's Bun.CryptoHasher does not provide");
	}
	return new Bun.CryptoHasher("blake2b256");
}

/** Hash content bytes deterministically. */
export function hashContent(content: Uint8Array): ArtifactId {
	return artifactHasher().update(content).digest("hex");
}

/** Hash a string (UTF-8 encoded). */
export function hashText(text: string): ArtifactId {
	return hashContent(new TextEncoder().encode(text));
}

/** Artifact id → URI form used across the harness. */
export function artifactUri(id: ArtifactId): string {
	return `artifact://${id}`;
}

/**
 * Content-addressed immutable artifact store.
 *
 * Storage layout: `<dir>/<id[0..2]>/<id>` for the bytes. The store never
 * mutates or deletes artifact bytes; putting the same content again returns
 * the existing record (dedup). Reads verify the stored bytes hash to the id
 * (stale-write / corruption detection).
 */
export class ArtifactStore {
	#dir: string;
	#cache = new Map<ArtifactId, ArtifactRecord>();

	constructor(dir: string) {
		this.#dir = dir;
	}

	#pathFor(id: ArtifactId): string {
		return `${this.#dir}/${id.slice(0, 2)}/${id}`;
	}

	/**
	 * Store bytes; returns the (possibly pre-existing) artifact record.
	 * Deduplicates by content hash.
	 */
	async put(content: Uint8Array, metadata: ArtifactMetadata = {}): Promise<ArtifactRecord> {
		const id = hashContent(content);
		const cached = this.#cache.get(id);
		if (cached) return cached;

		const path = this.#pathFor(id);
		try {
			const existing = await Bun.file(path).stat();
			const record: ArtifactRecord = {
				id,
				kind: metadata.kind,
				bytes: existing.size,
				createdAt: existing.mtimeMs,
				algorithm: "blake2b256",
			};
			this.#cache.set(id, record);
			return record;
		} catch {
			// Not present yet — write below.
		}
		await Bun.write(path, content);
		const record: ArtifactRecord = {
			id,
			kind: metadata.kind,
			bytes: content.byteLength,
			createdAt: Date.now(),
			algorithm: "blake2b256",
		};
		this.#cache.set(id, record);
		return record;
	}

	/** Store text content; convenience wrapper over {@link put}. */
	async putText(text: string, metadata: ArtifactMetadata = {}): Promise<ArtifactRecord> {
		return this.put(new TextEncoder().encode(text), metadata);
	}

	/** Fetch artifact bytes, verifying content integrity. Returns null if absent. */
	async read(id: ArtifactId): Promise<Uint8Array | null> {
		const path = this.#pathFor(id);
		try {
			const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
			const actual = hashContent(bytes);
			if (actual !== id) {
				throw new Error(`artifact integrity violation: stored bytes hash to ${actual}, expected ${id}`);
			}
			return bytes;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	/** Fetch artifact text. Returns null if absent or not valid UTF-8. */
	async readText(id: ArtifactId): Promise<string | null> {
		const bytes = await this.read(id);
		return bytes ? new TextDecoder().decode(bytes) : null;
	}

	/** Metadata record without reading bytes; null if absent. */
	async describe(id: ArtifactId): Promise<ArtifactRecord | null> {
		const cached = this.#cache.get(id);
		if (cached) return cached;
		try {
			const stat = await Bun.file(this.#pathFor(id)).stat();
			const record: ArtifactRecord = {
				id,
				bytes: stat.size,
				createdAt: stat.mtimeMs,
				algorithm: "blake2b256",
			};
			this.#cache.set(id, record);
			return record;
		} catch {
			return null;
		}
	}

	/** True when the id exists in the store. */
	async has(id: ArtifactId): Promise<boolean> {
		return (await this.describe(id)) !== null;
	}

	/**
	 * Canonical on-disk path for an artifact id (single blob). Other surfaces
	 * may hardlink aliases to this path so the bytes exist once.
	 */
	pathFor(id: ArtifactId): string {
		return this.#pathFor(id);
	}
}
