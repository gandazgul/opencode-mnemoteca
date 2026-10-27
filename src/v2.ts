import {
  MEMORY_INSTRUCTIONS,
  TOOLS,
  ensureCollection,
  projectName,
  type Logger,
  type RunOpts,
  type ToolSpec,
} from "./core.js";

// Minimal local declarations of the OpenCode v2 plugin context (no SDK dependency).
type V2Tool = {
  name: string;
  description: string;
  input: object;
  options: { codemode: false };
  execute(input: any, tctx: { signal: AbortSignal }): Promise<{ content: string }>;
};

type V2Context = {
  location: { directory: string };
  tool: {
    transform(fn: (t: { add(def: V2Tool): void }) => void): Promise<void>;
  };
  session: {
    hook(
      name: "context",
      fn: (e: { system: Array<{ type: "text"; text: string }> }) => void | Promise<void>,
    ): Promise<unknown> | unknown;
  };
};

// The v2 context exposes no logging facility, and console.* would corrupt the TUI.
const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function toJsonSchema(spec: ToolSpec): object {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const [key, arg] of Object.entries(spec.args)) {
    properties[key] = { type: arg.type, description: arg.description };
    if (!arg.optional) {
      required.push(key);
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export async function setup(ctx: unknown): Promise<void> {
  const c = ctx as Partial<V2Context> | undefined;
  if (typeof c?.tool?.transform !== "function" || typeof c?.session?.hook !== "function") {
    return;
  }
  const { tool, session, location } = c as V2Context;

  const dir = location.directory;
  const project = projectName(dir);
  const log = noopLog;

  await ensureCollection(["init", "--name", project], { cwd: dir, log });

  // Built once: the host replays the transform on reloads and caches codecs by object identity.
  const inputs = new Map(TOOLS.map((spec) => [spec.name, toJsonSchema(spec)]));

  await tool.transform((t) => {
    for (const spec of TOOLS) {
      t.add({
        name: spec.name,
        description: spec.description,
        input: inputs.get(spec.name)!,
        options: { codemode: false },
        async execute(input, tctx) {
          const opts: RunOpts = { cwd: dir, log, signal: tctx?.signal };
          return { content: await spec.execute(input, { project, opts }) };
        },
      });
    }
  });

  await session.hook("context", (e) => {
    e.system.push({ type: "text", text: MEMORY_INSTRUCTIONS });
  });
}
