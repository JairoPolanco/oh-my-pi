/**
 * Cross-process contract for the broker-owned kernel gateway daemon.
 *
 * One gateway daemon runs per project scope (launched through the same daemon
 * broker that owns the shared Chromium, browser relay, and LSP mux). It binds
 * {@link Gateway.global} — the ONE control plane above every session host —
 * to a real HTTP JSON-RPC + WebSocket endpoint so external tools, dashboards,
 * and RLM bridges can call into the kernel and subscribe to its event fan-out
 * without a local socket/port dance per process.
 *
 * Everything below is shared by the worker entry (`server.ts`), the client
 * connector (`daemon.ts`), and tests.
 */

/** Hidden CLI selector used to re-enter the kernel gateway worker. */
export const KERNEL_GATEWAY_WORKER_ARG = "__omp_worker_kernel_gateway";

/** Environment key carrying the canonical project directory the gateway serves. */
export const KERNEL_GATEWAY_PROJECT_DIR_ENV = "OMP_KERNEL_GATEWAY_PROJECT_DIR";

/** Stable broker daemon name for the shared kernel gateway. */
export const KERNEL_GATEWAY_DAEMON_NAME = "omp.kernel.gateway";

/** Broker readiness regex matched against the banner printed by the worker. */
export const KERNEL_GATEWAY_READY_PATTERN = String.raw`omp kernel gateway listening on \S+:\d+`;

/** Banner printed on stdout once the gateway HTTP/WS server accepts connections. */
export function kernelGatewayReadyBanner(hostname: string, port: number): string {
	return `omp kernel gateway listening on ${hostname}:${port}`;
}

/**
 * Extract `hostname:port` from a ready snapshot's `readyMatch`.
 */
export function kernelGatewayEndpointOf(readyMatch: string | undefined): { hostname: string; port: number } | null {
	const match = readyMatch?.match(/listening on (\S+):(\d+)/);
	if (!match) return null;
	return { hostname: match[1]!, port: Number(match[2]) };
}
