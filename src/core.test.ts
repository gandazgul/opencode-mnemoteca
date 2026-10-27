import assert from "node:assert/strict";
import test from "node:test";
import { TOOLS, projectName, run } from "./core.js";

type SpawnCall = {
  command: string[];
  options: { cwd?: string; stdout?: string; stderr?: string; signal?: AbortSignal };
};

type Stub = { stdout?: string; stderr?: string; exited?: number };

function installBunBoundary(stub: Stub = {}): SpawnCall[] {
  const calls: SpawnCall[] = [];
  globalThis.Bun = {
    spawn(command: string[], options: SpawnCall["options"]) {
      calls.push({ command, options });
      return {
        stdout: stub.stdout ?? "ok\n",
        stderr: stub.stderr ?? "",
        exited: Promise.resolve(stub.exited ?? 0),
      };
    },
  } as any;
  return calls;
}

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

test("projectName maps global and trailing slash", () => {
  assert.equal(projectName("/x/global/"), "default");
  assert.equal(projectName("/tmp/my repo ż/"), "my repo ż");
  assert.equal(projectName("/"), "default");
});

test("run omits signal when undefined", async () => {
  const calls = installBunBoundary();
  await run(["search", "x"], { cwd: "/work/p", log });
  assert.equal(calls.length, 1);
  assert.equal("signal" in calls[0]!.options, false);
  assert.deepEqual(calls[0]!.options, { cwd: "/work/p", stdout: "pipe", stderr: "pipe" });
});

test("run forwards signal", async () => {
  const calls = installBunBoundary();
  const controller = new AbortController();
  await run(["search", "x"], { cwd: "/work/p", log, signal: controller.signal });
  assert.equal(calls[0]!.options.signal, controller.signal);
});

test("run throws stderr on non-zero exit", async () => {
  installBunBoundary({ stdout: "", stderr: "boom", exited: 3 });
  await assert.rejects(run(["search", "x"], { cwd: "/work/p", log }), new Error("boom"));
});

test("run surfaces real stderr that contains 'not found' instead of install guidance", async () => {
  installBunBoundary({ stdout: "", stderr: "Error: document 487 not found\n", exited: 1 });
  await assert.rejects(
    run(["delete", "487"], { cwd: "/work/p", log }),
    new Error("Error: document 487 not found"),
  );
});

test("run falls back to an exit-code message when stderr is empty", async () => {
  installBunBoundary({ stdout: "", stderr: "", exited: 2 });
  await assert.rejects(
    run(["delete", "5"], { cwd: "/work/p", log }),
    new Error("mnemoteca delete failed (exit 2)"),
  );
});

test("run returns install guidance when spawn throws ENOENT", async () => {
  globalThis.Bun = {
    spawn() {
      throw new Error("ENOENT");
    },
  } as any;
  const result = await run(["search", "x"], { cwd: "/work/p", log });
  assert.equal(
    result,
    "Error: mnemoteca binary not found. Install it: https://github.com/gandazgul/mnemoteca#install",
  );
});

test("TOOLS order and names", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ["memory_recall", "memory_recall_global", "memory_store", "memory_store_global", "memory_delete"],
  );
});

declare global {
  // Test boundary for the OpenCode host runtime.
  var Bun: any;
}
