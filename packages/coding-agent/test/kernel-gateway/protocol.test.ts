import { describe, expect, test } from "bun:test";
import {
	KERNEL_GATEWAY_DAEMON_NAME,
	KERNEL_GATEWAY_READY_PATTERN,
	KERNEL_GATEWAY_WORKER_ARG,
	kernelGatewayEndpointOf,
	kernelGatewayReadyBanner,
} from "../../src/kernel-gateway/protocol";

describe("kernel gateway protocol", () => {
	test("ready banner matches the broker readiness pattern", () => {
		const banner = kernelGatewayReadyBanner("127.0.0.1", 12345);
		expect(new RegExp(KERNEL_GATEWAY_READY_PATTERN).test(banner)).toBe(true);
	});

	test("endpoint extraction reads hostname:port from the ready banner", () => {
		const banner = kernelGatewayReadyBanner("127.0.0.1", 54653);
		const endpoint = kernelGatewayEndpointOf(banner);
		expect(endpoint).toEqual({ hostname: "127.0.0.1", port: 54653 });
	});

	test("endpoint extraction tolerates the exact banner line from stdout", () => {
		// The worker writes the banner followed by a newline; the smoke probe
		// matches against the accumulated stdout buffer.
		const line = `${kernelGatewayReadyBanner("127.0.0.1", 9999)}\n`;
		expect(kernelGatewayEndpointOf(line)).toEqual({ hostname: "127.0.0.1", port: 9999 });
	});

	test("endpoint extraction returns null for non-banner output", () => {
		expect(kernelGatewayEndpointOf(undefined)).toBeNull();
		expect(kernelGatewayEndpointOf("some other daemon output")).toBeNull();
	});

	test("worker selector and daemon name are stable contract values", () => {
		expect(KERNEL_GATEWAY_WORKER_ARG).toBe("__omp_worker_kernel_gateway");
		expect(KERNEL_GATEWAY_DAEMON_NAME).toBe("omp.kernel.gateway");
	});
});
