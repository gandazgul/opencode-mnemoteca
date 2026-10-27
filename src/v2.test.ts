import assert from "node:assert/strict";
import test from "node:test";
import plugin, { MnemotecaPlugin } from "./index.js";
import { MEMORY_INSTRUCTIONS, TOOLS } from "./core.js";
import { setup } from "./v2.js";

type SpawnCall = {
  command: string[];
  options: { cwd?: string; stdout?: string; stderr?: string; signal?: AbortSignal };
};

type Stub = {
  stdout?: string;
  stderr?: string;
  exited?: number;
  throws?: Error;
  abortable?: boolean;
};

function installBunBoundary(stub: Stub = {}): SpawnCall[] {
  const calls: SpawnCall[] = [];
  globalThis.Bun = {
    spawn(command: string[], options: SpawnCall["options"]) {
      calls.push({ command, options });
      if (stub.throws) {
        throw stub.throws;
      }
      const exited =
        stub.abortable && options.signal
          ? new Promise<number>((_resolve, reject) => {
              const signal = options.signal!;
              const fail = () => reject(new Error("The operation was aborted"));
              if (signal.aborted) {
                fail();
              }
              else {
                signal.addEventListener("abort", fail, { once: true });
              }
            })
          : Promise.resolve(stub.exited ?? 0);
      return {
        stdout: stub.stdout ?? "ok\n",
        stderr: stub.stderr ?? "",
        exited,
      };
    },
  } as any;
  return calls;
}

type AddedTool = {
  name: string;
  description: string;
  input: any;
  options: { codemode: boolean };
  execute(input: any, tctx?: { signal: AbortSignal }): Promise<{ content: string }>;
};

// The v2 adapter must never write to the console: console.* corrupts the OpenCode v2 TUI.
// Spy on every console method so a test can assert that nothing was written.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

function spyConsole(): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const originals = CONSOLE_METHODS.map((m) => [m, console[m]] as const);
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args: unknown[]) => void calls.push(`${m}: ${args.map(String).join(" ")}`);
  }
  return {
    calls,
    restore() {
      for (const [m, fn] of originals) console[m] = fn;
    },
  };
}

function fakeV2Ctx(directory: string) {
  const tools: AddedTool[] = [];
  const hooks: Array<{ name: string; fn: (e: any) => unknown }> = [];
  const ctx = {
    location: { directory },
    tool: {
      async transform(fn: (t: { add(def: AddedTool): void }) => void) {
        fn({ add: (def) => void tools.push(def) });
      },
    },
    session: {
      hook(name: string, fn: (e: any) => unknown) {
        hooks.push({ name, fn });
      },
    },
  };
  return { ctx, tools, hooks };
}

const byName = (tools: AddedTool[], name: string): AddedTool => {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} registered`);
  return found;
};

test("registers five tools with codemode false", async () => {
  installBunBoundary();
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  await setup(ctx);

  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const t of tools) {
    assert.equal(t.options.codemode, false);
    assert.equal(t.input.type, "object");
    assert.equal(t.input.additionalProperties, false);
  }
});

test("schemas mirror v1 args", async () => {
  installBunBoundary();
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  await setup(ctx);

  const store = byName(tools, "memory_store");
  assert.deepEqual(store.input.required, ["content"]);
  assert.equal(store.input.properties.content.type, "string");
  assert.equal(store.input.properties.core.type, "boolean");
  assert.equal(byName(tools, "memory_delete").input.properties.id.type, "number");
});

test("execute returns content and uses location cwd", async () => {
  const calls = installBunBoundary();
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  await setup(ctx);

  const signal = new AbortController().signal;
  const result = await byName(tools, "memory_recall").execute({ query: "x" }, { signal });

  assert.deepEqual(result, { content: "ok" });
  const last = calls[calls.length - 1]!;
  assert.deepEqual(last.command, ["mnemoteca", "search", "--name", "acme", "--format", "plain", '"x"']);
  assert.equal(last.options.cwd, "/tmp/acme");
  assert.equal(last.options.signal, signal);
});

test("omitted core matches v1 argv", async () => {
  const calls = installBunBoundary();
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  await setup(ctx);

  await byName(tools, "memory_store").execute({ content: "c" });
  assert.deepEqual(calls[calls.length - 1]!.command, ["mnemoteca", "add", "--name", "acme", "c"]);
});

test("init uses mapped project name as one argv", async () => {
  let calls = installBunBoundary();
  await setup(fakeV2Ctx("/tmp/my repo ż").ctx);
  assert.deepEqual(calls[0]!.command, ["mnemoteca", "init", "--name", "my repo ż"]);

  calls = installBunBoundary();
  await setup(fakeV2Ctx("/x/global").ctx);
  assert.deepEqual(calls[0]!.command, ["mnemoteca", "init", "--name", "default"]);
});

test("non-zero exit surfaces stderr", async () => {
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  installBunBoundary();
  await setup(ctx);
  installBunBoundary({ stdout: "", stderr: "bad", exited: 1 });

  await assert.rejects(byName(tools, "memory_recall").execute({ query: "x" }), new Error("bad"));
});

test("non-zero exit with 'not found' stderr surfaces the real message, not install guidance", async () => {
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  installBunBoundary();
  await setup(ctx);
  installBunBoundary({ stdout: "", stderr: "Error: document 999 not found\n", exited: 1 });

  await assert.rejects(
    byName(tools, "memory_delete").execute({ id: 999 }),
    new Error("Error: document 999 not found"),
  );
});

test("failing execute writes nothing to the console", async () => {
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  installBunBoundary();
  await setup(ctx);
  installBunBoundary({ stdout: "", stderr: "boom", exited: 1 });

  const spy = spyConsole();
  try {
    await assert.rejects(byName(tools, "memory_recall").execute({ query: "x" }), new Error("boom"));
  }
  finally {
    spy.restore();
  }
  assert.deepEqual(spy.calls, []);
});

test("abort rejects", async () => {
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  installBunBoundary();
  await setup(ctx);
  installBunBoundary({ abortable: true });

  const controller = new AbortController();
  const pending = byName(tools, "memory_recall").execute({ query: "x" }, { signal: controller.signal });
  controller.abort();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("did not reject within 100ms")), 100);
  });
  try {
    await assert.rejects(Promise.race([pending, timeout]), /aborted/);
  }
  finally {
    clearTimeout(timer);
  }
});

test("context hook pushes instructions", async () => {
  installBunBoundary();
  const { ctx, hooks } = fakeV2Ctx("/tmp/acme");
  await setup(ctx);

  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]!.name, "context");
  const event = { system: [] as Array<{ type: "text"; text: string }> };
  await hooks[0]!.fn(event);
  assert.deepEqual(event.system, [{ type: "text", text: MEMORY_INSTRUCTIONS }]);
});

test("guard: v1-shaped ctx does nothing", async () => {
  const calls = installBunBoundary();
  await setup({ directory: "/tmp/a", client: {} });
  assert.equal(calls.length, 0);
});

test("missing binary", async () => {
  const { ctx, tools } = fakeV2Ctx("/tmp/acme");
  installBunBoundary({ throws: new Error("ENOENT") });

  const spy = spyConsole();
  let result: { content: string };
  try {
    await setup(ctx);
    result = await byName(tools, "memory_recall").execute({ query: "x" });
  }
  finally {
    spy.restore();
  }
  assert.deepEqual(result, {
    content: "Error: mnemoteca binary not found. Install it: https://github.com/gandazgul/mnemoteca#install",
  });
  assert.deepEqual(spy.calls, []);
});

test("default export shape", () => {
  assert.equal(plugin.id, "mnemoteca");
  assert.equal(plugin.server, MnemotecaPlugin);
  assert.equal(typeof plugin.setup, "function");
});
