import assert from "node:assert/strict";
import test from "node:test";
import { MnemotecaPlugin } from "./index";

type SpawnCall = {
  command: string[];
  options: { cwd?: string; stdout?: string; stderr?: string };
};

function installBunBoundary(responses: string[] = []): SpawnCall[] {
  const calls: SpawnCall[] = [];
  const outputQueue = [...responses];
  globalThis.Bun = {
    spawn(command: string[], options: SpawnCall["options"]) {
      calls.push({ command, options });
      const output = outputQueue.shift() ?? "ok\n";
      return {
        stdout: output,
        stderr: "",
        exited: Promise.resolve(0),
      };
    },
  } as any;
  return calls;
}

async function createPlugin(targetDir = "/tmp/acme") {
  const logs: any[] = [];
  const hooks = await MnemotecaPlugin({
    directory: targetDir,
    worktree: targetDir,
    client: {
      app: {
        log(input: any) {
          logs.push(input);
          return Promise.resolve();
        },
      },
    },
  } as any);
  return { hooks, logs };
}

test("registers stable memory tools and compaction guidance", async () => {
  const calls = installBunBoundary();
  const { hooks } = await createPlugin("/work/project");

  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
    "memory_delete",
    "memory_recall",
    "memory_recall_global",
    "memory_store",
    "memory_store_global",
  ]);

  const output = { context: [] as string[] };
  await hooks["experimental.session.compacting"]?.({} as any, output);
  assert.equal(output.context.length, 1);
  assert.match(output.context[0]!, /Persistent Memory \(Mnemoteca\)/);
  assert.match(output.context[0]!, /memory_recall_global/);
  assert.equal(calls[0]!.command[0], "mnemoteca");
  assert.deepEqual(calls[0]!.command, ["mnemoteca", "init", "--name", "project"]);
});

test("uses literal mnemoteca executable and preserves project tool arguments", async () => {
  const calls = installBunBoundary(["init\n", "found project\n", "stored\n", "deleted\n"]);
  const { hooks } = await createPlugin("/work/my-project");

  const recall = await hooks.tool!.memory_recall!.execute({ query: 'quoted "value"' } as any, {} as any);
  const store = await hooks.tool!.memory_store!.execute({ content: "keep this", core: true } as any, {} as any);
  const deleted = await hooks.tool!.memory_delete!.execute({ id: 42 } as any, {} as any);

  assert.equal(recall, "found project");
  assert.equal(store, "stored");
  assert.equal(deleted, "deleted");
  assert.deepEqual(calls.map((call) => call.command), [
    ["mnemoteca", "init", "--name", "my-project"],
    ["mnemoteca", "search", "--name", "my-project", "--format", "plain", '"quoted ""value"""'],
    ["mnemoteca", "add", "--name", "my-project", "--tag", "core", "keep this"],
    ["mnemoteca", "delete", "42"],
  ]);
  assert.ok(calls.every((call) => call.options.cwd === "/work/my-project"));
});

test("preserves global operations and project fallback", async () => {
  const calls = installBunBoundary(["init\n", "global found\n", "global init\n", "global stored\n"]);
  const { hooks } = await createPlugin("/work/global/");

  const recall = await hooks.tool!.memory_recall_global!.execute({ query: "all" } as any, {} as any);
  const store = await hooks.tool!.memory_store_global!.execute({ content: "global memory", core: true } as any, {} as any);

  assert.equal(recall, "global found");
  assert.equal(store, "global stored");
  assert.deepEqual(calls.map((call) => call.command), [
    ["mnemoteca", "init", "--name", "default"],
    ["mnemoteca", "search", "--global", "--format", "plain", '"all"'],
    ["mnemoteca", "init", "--global"],
    ["mnemoteca", "add", "--global", "--tag", "core", "global memory"],
  ]);
});

test("returns Mnemoteca install guidance when the executable is missing", async () => {
  globalThis.Bun = {
    spawn(command: string[], options: SpawnCall["options"]) {
      if (command.includes("init")) {
        return { stdout: "", stderr: "", exited: Promise.resolve(0) };
      }
      throw new Error("ENOENT");
    },
  } as any;

  const { hooks } = await createPlugin("/work/project");
  const result = await hooks.tool!.memory_recall!.execute({ query: "anything" } as any, {} as any);
  assert.equal(result, "Error: mnemoteca binary not found. Install it: https://github.com/gandazgul/mnemoteca#install");
});

test("surfaces the real CLI error instead of install guidance on a non-zero exit", async () => {
  globalThis.Bun = {
    spawn(command: string[], options: SpawnCall["options"]) {
      if (command.includes("init")) {
        return { stdout: "", stderr: "", exited: Promise.resolve(0) };
      }
      return { stdout: "", stderr: "Error: document 999 not found\n", exited: Promise.resolve(1) };
    },
  } as any;

  const { hooks } = await createPlugin("/work/project");
  await assert.rejects(
    hooks.tool!.memory_delete!.execute({ id: 999 } as any, {} as any),
    new Error("Error: document 999 not found"),
  );
});

declare global {
  // Test boundary for the OpenCode host runtime.
  var Bun: any;
}
