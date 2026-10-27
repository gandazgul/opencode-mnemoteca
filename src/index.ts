import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  MEMORY_INSTRUCTIONS,
  TOOLS,
  ensureCollection,
  projectName,
  type Logger,
  type RunOpts,
  type ToolSpec,
} from "./core.js";
import { setup } from "./v2.js";

function toV1Args(spec: ToolSpec) {
  const args: Record<string, any> = {};
  for (const [key, arg] of Object.entries(spec.args)) {
    let schema: any =
      arg.type === "string"
        ? tool.schema.string()
        : arg.type === "number"
          ? tool.schema.number()
          : tool.schema.boolean();
    if (arg.optional) {
      schema = schema.optional();
    }
    args[key] = schema.describe(arg.description);
  }
  return args;
}

export const MnemotecaPlugin: Plugin = async (ctx) => {
  const { directory, worktree, client } = ctx;
  const targetDir = directory || worktree || process.cwd();

  const appLog = (level: "debug" | "info" | "warn" | "error") => (msg: string): Promise<void> =>
    client.app
      .log({ body: { service: "mnemoteca", level, message: msg } })
      .then(() => {}, () => {});

  const log: Logger = {
    debug: appLog("debug"),
    info: appLog("info"),
    warn: appLog("warn"),
    error: appLog("error"),
  };

  const project = projectName(targetDir);
  const opts: RunOpts = { cwd: targetDir, log };

  await log.debug(`Plugin loaded for project: ${project} (dir: ${targetDir})`);

  // Auto-init the project collection (idempotent).
  await ensureCollection(["init", "--name", project], opts);

  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const spec of TOOLS) {
    tools[spec.name] = tool({
      description: spec.description,
      args: toV1Args(spec),
      async execute(args: any) {
        return spec.execute(args, { project, opts });
      },
    });
  }

  return {
    tool: tools,

    // Inject memory instructions into compaction so they survive context window resets.
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(MEMORY_INSTRUCTIONS);
    },
  };
};

export default { id: "mnemoteca", server: MnemotecaPlugin, setup };
