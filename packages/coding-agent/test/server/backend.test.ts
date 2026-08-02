import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createReadTool,
	type InMemorySessionCreateOptions,
	InMemorySessionRepository,
	type SessionMetadata,
	type SessionRepository,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TranscriptProgress } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { CodingAgentServerBackend, toPiServerError } from "../../src/server/backend.ts";
import { createServerBackendFixture, removeServerBackendFixture } from "./fixture.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function settlesBeforeNextTurn(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
	]);
}

describe("coding-agent server backend", () => {
	test("normalizes snapshots, restores model/thinking, and holds an exclusive session lock", async () => {
		const fixture = await createServerBackendFixture();
		let runtime = await fixture.backend.createSession({
			id: "server-session-1",
			cwd: fixture.cwd,
			name: "Backend test",
			model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
			thinkingLevel: "high",
		});
		try {
			const initial = await runtime.snapshot();
			expect(initial).toMatchObject({
				id: "server-session-1",
				name: "Backend test",
				cwd: fixture.cwd,
				phase: "idle",
				model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
				thinkingLevel: "high",
				revision: 0,
				transcript: [],
				locked: true,
			});

			const models = await fixture.backend.listModels();
			expect(models).toContainEqual(
				expect.objectContaining({
					provider: fixture.faux.provider.id,
					id: "faux-reasoning",
					authenticated: true,
					supportedThinkingLevels: expect.arrayContaining(["off", "high"]),
				}),
			);
			const summaries = await fixture.backend.listSessions();
			expect(summaries).toContainEqual(
				expect.objectContaining({ id: "server-session-1", name: "Backend test", locked: true }),
			);

			const secondBackend = await CodingAgentServerBackend.create({
				defaultCwd: fixture.cwd,
				sessionRoot: join(fixture.root, "sessions"),
				modelRuntime: fixture.modelRuntime,
				settingsManager: fixture.settingsManager,
			});
			await expect(secondBackend.openSession("server-session-1")).rejects.toMatchObject({
				code: "session_locked",
			});

			fixture.faux.setResponses([fauxAssistantMessage("normalized response")]);
			const progress: TranscriptProgress[] = [];
			runtime.subscribe(() => {
				throw new Error("network subscriber failed");
			});
			runtime.subscribe((event) => {
				if (event.type === "progress") progress.push(event.progress);
			});
			await runtime.prompt({ text: "hello" });
			const completed = await runtime.snapshot();
			expect(completed.revision).toBeGreaterThan(initial.revision);
			expect(completed.phase).toBe("idle");
			expect(completed.transcript.map((item) => item.role)).toEqual(["user", "assistant"]);
			expect(completed.transcript[1]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "normalized response" }],
				status: "complete",
				stopReason: "stop",
			});
			expect(completed.transcript.some((item) => "parentId" in item)).toBe(false);
			expect(progress.some((event) => event.type === "assistant_delta")).toBe(true);

			await runtime.setModel({ provider: fixture.faux.provider.id, id: "faux-plain" });
			expect(await runtime.snapshot()).toMatchObject({
				model: { provider: fixture.faux.provider.id, id: "faux-plain" },
				thinkingLevel: "off",
			});
			await runtime.setModel({ provider: fixture.faux.provider.id, id: "faux-reasoning" });
			await runtime.setThinking("high");

			await runtime.dispose();
			const persistedSummary = (await secondBackend.listSessions()).find(
				(summary) => summary.id === "server-session-1",
			);
			expect(persistedSummary).toBeDefined();
			runtime = await secondBackend.openSession("server-session-1");
			const restored = await runtime.snapshot();
			expect(restored.updatedAt).toBe(persistedSummary?.updatedAt);
			expect(restored.model).toEqual(initial.model);
			expect(restored.thinkingLevel).toBe("high");
			expect(restored.transcript).toEqual(completed.transcript);
		} finally {
			await runtime.dispose();
			await removeServerBackendFixture(fixture);
		}
	});
	test("does not expose sessions until initialization completes", async () => {
		const fixture = await createServerBackendFixture();
		const appendStarted = deferred();
		const releaseAppend = deferred();
		const sourceRepository = new InMemorySessionRepository();
		let blockNextAppend = true;
		const blockingRepository: SessionRepository<SessionMetadata, InMemorySessionCreateOptions> = {
			async create(options) {
				const session = await sourceRepository.create(options);
				const appendCustomEntry = session.appendCustomEntry.bind(session);
				session.appendCustomEntry = async (...args) => {
					if (blockNextAppend) {
						blockNextAppend = false;
						appendStarted.resolve();
						await releaseAppend.promise;
					}
					return appendCustomEntry(...args);
				};
				return session;
			},
			open: (metadata) => sourceRepository.open(metadata),
			list: () => sourceRepository.list(),
			delete: (metadata) => sourceRepository.delete(metadata),
			fork: (source, options) => sourceRepository.fork(source, options),
			[Symbol.asyncDispose]: () => sourceRepository[Symbol.asyncDispose](),
		};
		const backend = await CodingAgentServerBackend.create({
			defaultCwd: fixture.cwd,
			modelRuntime: fixture.modelRuntime,
			settingsManager: fixture.settingsManager,
			sessionRepository: blockingRepository,
			createSessionOptions: ({ id }) => ({ id }),
			lockRoot: join(fixture.root, "initialization-locks"),
		});
		let runtime: Awaited<ReturnType<typeof fixture.backend.createSession>> | undefined;
		try {
			const creating = backend.createSession({ id: "initializing-session", cwd: fixture.cwd });
			await appendStarted.promise;
			const listing = backend.listSessions();

			expect(await settlesBeforeNextTurn(listing)).toBe(false);
			releaseAppend.resolve();
			runtime = await creating;
			expect(await listing).toContainEqual(expect.objectContaining({ id: "initializing-session" }));
		} finally {
			releaseAppend.resolve();
			await runtime?.dispose();
			await sourceRepository[Symbol.asyncDispose]();
			await removeServerBackendFixture(fixture);
		}
	});

	test("builds its system prompt from harness tool metadata", async () => {
		const fixture = await createServerBackendFixture();
		const runtime = await fixture.backend.createSession({ id: "server-tool-prompt", cwd: fixture.cwd });
		let systemPrompt: string | undefined;
		fixture.faux.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt;
				return fauxAssistantMessage("ok");
			},
		]);
		try {
			await runtime.prompt({ text: "inspect tools" });
			expect(systemPrompt).toContain("- read: Read file contents");
			expect(systemPrompt).not.toContain(`- read: ${createReadTool().description}`);
			expect(systemPrompt).toContain("Use read to examine files instead of cat or sed.");
			expect(systemPrompt).toContain("Inspect PI_* environment variables for current model and session details.");
			expect(systemPrompt?.indexOf("Inspect PI_* environment variables")).toBeLessThan(
				systemPrompt?.indexOf("Use read to examine files") ?? -1,
			);
		} finally {
			await runtime.dispose();
			await removeServerBackendFixture(fixture);
		}
	});

	test("uses an injected SessionRepository without depending on storage metadata", async () => {
		const fixture = await createServerBackendFixture();
		const sessionRepository = new InMemorySessionRepository();
		const backend = await CodingAgentServerBackend.create({
			defaultCwd: fixture.cwd,
			modelRuntime: fixture.modelRuntime,
			settingsManager: fixture.settingsManager,
			sessionRepository,
			createSessionOptions: ({ id }) => ({ id }),
			lockRoot: join(fixture.root, "memory-locks"),
		});
		let runtime = await backend.createSession({ id: "memory-session", cwd: fixture.cwd });
		try {
			await runtime.dispose();
			expect(await sessionRepository.list()).toEqual([
				expect.not.objectContaining({ cwd: expect.anything(), path: expect.anything() }),
			]);
			expect(await backend.listSessions()).toContainEqual(
				expect.objectContaining({ id: "memory-session", cwd: fixture.cwd }),
			);
			runtime = await backend.openSession("memory-session");
			expect(await runtime.snapshot()).toMatchObject({ id: "memory-session", cwd: fixture.cwd });
		} finally {
			await runtime.dispose();
			await sessionRepository[Symbol.asyncDispose]();
			await removeServerBackendFixture(fixture);
		}
	});

	test("accepts a session cwd that is a symlink to a directory", async () => {
		const fixture = await createServerBackendFixture();
		const linkedCwd = join(fixture.root, "linked-workspace");
		await symlink(fixture.cwd, linkedCwd, "dir");
		const runtime = await fixture.backend.createSession({ id: "symlink-cwd", cwd: linkedCwd });
		try {
			expect(await runtime.snapshot()).toMatchObject({ cwd: linkedCwd });
		} finally {
			await runtime.dispose();
			await removeServerBackendFixture(fixture);
		}
	});

	test("rejects a persisted cwd that is no longer a directory", async () => {
		const fixture = await createServerBackendFixture();
		const runtime = await fixture.backend.createSession({ id: "invalid-persisted-cwd", cwd: fixture.cwd });
		await runtime.dispose();
		await rm(fixture.cwd, { recursive: true });
		await writeFile(fixture.cwd, "not a directory");
		try {
			await expect(fixture.backend.openSession("invalid-persisted-cwd")).rejects.toMatchObject({
				code: "invalid_request",
				message: expect.stringContaining("Invalid session cwd"),
			});
		} finally {
			await removeServerBackendFixture(fixture);
		}
	});

	test("removes inherited PI_SESSION_FILE for non-file-backed sessions", async () => {
		const fixture = await createServerBackendFixture();
		const sessionRepository = new InMemorySessionRepository();
		const backend = await CodingAgentServerBackend.create({
			defaultCwd: fixture.cwd,
			modelRuntime: fixture.modelRuntime,
			settingsManager: fixture.settingsManager,
			sessionRepository,
			createSessionOptions: ({ id }) => ({ id }),
			lockRoot: join(fixture.root, "environment-locks"),
		});
		const previousSessionFile = process.env.PI_SESSION_FILE;
		process.env.PI_SESSION_FILE = "inherited-session.jsonl";
		const runtime = await backend.createSession({
			id: "memory-environment",
			cwd: fixture.cwd,
			model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
		});
		try {
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: `printf '%s' "\${PI_SESSION_FILE-unset}"` }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await runtime.prompt({ text: "inspect environment" });
			const tool = (await runtime.snapshot()).transcript.find((item) => item.role === "tool");
			if (!tool || tool.role !== "tool") throw new Error("Expected tool transcript item");
			expect(tool.content).toContainEqual({ type: "text", text: "unset" });
		} finally {
			await runtime.dispose();
			if (previousSessionFile === undefined) delete process.env.PI_SESSION_FILE;
			else process.env.PI_SESSION_FILE = previousSessionFile;
			await sessionRepository[Symbol.asyncDispose]();
			await removeServerBackendFixture(fixture);
		}
	});

	test("preserves unexpected operational errors for boundary-safe handling", () => {
		const operational = new Error("private filesystem detail");
		expect(toPiServerError(operational)).toBe(operational);
	});
	test("applies server-only defaults to newly created sessions", async () => {
		const fixture = await createServerBackendFixture();
		fixture.backend.setDefaultSessionOptions({
			model: { provider: fixture.faux.provider.id, id: "faux-plain" },
			thinkingLevel: "off",
		});
		const runtime = await fixture.backend.createSession({ id: "server-defaults", cwd: fixture.cwd });
		try {
			expect(await runtime.snapshot()).toMatchObject({
				model: { provider: fixture.faux.provider.id, id: "faux-plain" },
				thinkingLevel: "off",
			});
		} finally {
			await runtime.dispose();
			await removeServerBackendFixture(fixture);
		}
	});
	test("maps unsupported model and thinking requests to protocol-safe errors", async () => {
		const fixture = await createServerBackendFixture();
		try {
			await expect(
				fixture.backend.createSession({
					id: "bad-model",
					cwd: fixture.cwd,
					model: { provider: "missing", id: "missing" },
				}),
			).rejects.toMatchObject({
				name: "PiServerError",
				code: "invalid_request",
				message: expect.stringContaining("Could not resolve missing/missing"),
			});
			await expect(
				fixture.backend.createSession({
					id: "bad-thinking",
					cwd: fixture.cwd,
					model: { provider: fixture.faux.provider.id, id: "faux-reasoning" },
					thinkingLevel: "max",
				}),
			).rejects.toMatchObject({
				name: "PiServerError",
				code: "invalid_request",
				message: expect.stringContaining("not supported"),
			});
		} finally {
			await removeServerBackendFixture(fixture);
		}
	});
});
