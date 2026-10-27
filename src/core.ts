import path from "node:path";

export type Logger = {
  debug(m: string): Promise<void> | void;
  info(m: string): Promise<void> | void;
  warn(m: string): Promise<void> | void;
  error(m: string): Promise<void> | void;
};

export type RunOpts = { cwd: string; log: Logger; signal?: AbortSignal };

export type ToolName =
  | "memory_recall"
  | "memory_recall_global"
  | "memory_store"
  | "memory_store_global"
  | "memory_delete";

export type ToolSpec = {
  name: ToolName;
  description: string;
  args: Record<
    string,
    { type: "string" | "number" | "boolean"; description: string; optional?: true }
  >;
  execute(args: any, ctx: { project: string; opts: RunOpts }): Promise<string>;
};

export function projectName(dir: string): string {
  // Strip trailing slashes but keep the root slash if it is just "/".
  const projectDir = dir.replace(/(.+?)\/+$/, "$1");
  const projectRaw = path.basename(projectDir);
  return projectRaw === "global" ? "default" : (projectRaw || "default");
}

function spawnOptions(
  opts: RunOpts,
  stdout: "pipe" | "ignore",
): { cwd: string; stdout: string; stderr: string; signal?: AbortSignal } {
  const options: { cwd: string; stdout: string; stderr: string; signal?: AbortSignal } = {
    cwd: opts.cwd,
    stdout,
    stderr: "pipe",
  };
  if (opts.signal !== undefined) {
    options.signal = opts.signal;
  }
  return options;
}

/**
 * Run the Mnemoteca CLI binary gracefully using Bun.spawn.
 * Avoid shell interpolation entirely by passing args as an array.
 */
export async function run(args: string[], opts: RunOpts): Promise<string> {
  const { log } = opts;
  await log.debug(`Executing: mnemoteca ${args.join(" ")}`);

  let proc: { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> };
  try {
    // @ts-ignore - Bun is globally available in the OpenCode environment.
    proc = Bun.spawn(["mnemoteca", ...args], spawnOptions(opts, "pipe"));
  }
  catch (e: unknown) {
    // Only a failure to start the process itself (e.g. ENOENT on the executable)
    // means the binary is missing. A non-zero exit is a normal domain error and is
    // handled below — never classify CLI output by substring.
    await log.error(`Spawn failed: ${String(e)}`);
    return "Error: mnemoteca binary not found. Install it: https://github.com/gandazgul/mnemoteca#install";
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    await log.error(`Execution failed (code ${exitCode}): ${stderr}`);
    throw new Error(stderr.trim() || `mnemoteca ${args[0]} failed (exit ${exitCode})`);
  }

  // Mnemoteca can write output to stderr in older compatible paths. Use whichever has content.
  const output = stdout || stderr;
  await log.debug(`Execution successful. Output size: ${output.length}`);
  return output;
}

/**
 * Ensure a collection exists (idempotent). `args` is `["init", "--name", project]`
 * or `["init", "--global"]`. Failures are logged, never thrown.
 */
export async function ensureCollection(args: string[], opts: RunOpts): Promise<void> {
  const { log } = opts;
  const isGlobal = args.includes("--global");
  try {
    // @ts-ignore - Bun is globally available in the OpenCode environment.
    await Bun.spawn(["mnemoteca", ...args], spawnOptions(opts, "ignore")).exited;
    await log.info(
      isGlobal
        ? "Ensured global collection exists."
        : `Ensured collection exists: ${args[args.indexOf("--name") + 1]}`,
    );
  }
  catch (e) {
    await log.warn(
      isGlobal
        ? `Failed to auto-init global collection: ${e}`
        : `Failed to auto-init collection: ${e}`,
    );
  }
}

// Quote the query to prevent SQLite FTS errors with hyphens and special characters.
const quote = (query: string): string => `"${query.replaceAll('"', '""')}"`;

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "memory_recall",
    description:
      "Search project memory for relevant context, past decisions, and preferences. Use this at the start of conversations and whenever past context would help.",
    args: {
      query: { type: "string", description: "Semantic search query" },
    },
    async execute(args, { project, opts }) {
      await opts.log.info(`Searching project memory for: ${args.query}`);
      const result = await run(
        ["search", "--name", project, "--format", "plain", quote(args.query)],
        opts,
      );
      return result.trim() || "No memories found.";
    },
  },
  {
    name: "memory_recall_global",
    description:
      "Search global memory for cross-project preferences, decisions and patterns.",
    args: {
      query: { type: "string", description: "Semantic search query" },
    },
    async execute(args, { opts }) {
      await opts.log.info(`Searching global memory for: ${args.query}`);
      const result = await run(
        ["search", "--global", "--format", "plain", quote(args.query)],
        opts,
      );
      return result.trim() || "No global memories found.";
    },
  },
  {
    name: "memory_store",
    description:
      "Store a project memory: a decision, preference, or important context. One concise concept per memory. Set core=true for critical context that should always be available in every session (use sparingly).",
    args: {
      content: { type: "string", description: "Concise memory to store" },
      core: {
        type: "boolean",
        optional: true,
        description:
          "If true, this memory is always injected into context (like AGENTS.md). Use sparingly.",
      },
    },
    async execute(args, { project, opts }) {
      await opts.log.info(`Storing project memory: ${args.content}`);
      const cmdArgs = ["add", "--name", project];
      if (args.core) {
        cmdArgs.push("--tag", "core");
      }
      cmdArgs.push(args.content);
      return (await run(cmdArgs, opts)).trim();
    },
  },
  {
    name: "memory_store_global",
    description:
      "Store a cross-project memory: personal preferences, coding style, tool choices. Set core=true for critical cross-project context that should always be available.",
    args: {
      content: { type: "string", description: "Global memory to store" },
      core: {
        type: "boolean",
        optional: true,
        description:
          "If true, this memory is always injected into context. Use sparingly.",
      },
    },
    async execute(args, { opts }) {
      await opts.log.info(`Storing global memory: ${args.content}`);
      // Ensure the global collection exists.
      await ensureCollection(["init", "--global"], opts);
      const cmdArgs = ["add", "--global"];
      if (args.core) {
        cmdArgs.push("--tag", "core");
      }
      cmdArgs.push(args.content);
      return (await run(cmdArgs, opts)).trim();
    },
  },
  {
    name: "memory_delete",
    description:
      "Delete an outdated or incorrect memory by its document ID (shown in [brackets] in recall/list results).",
    args: {
      id: { type: "number", description: "Document ID to delete" },
    },
    async execute(args, { opts }) {
      await opts.log.info(`Deleting memory document ID: ${args.id}`);
      return (await run(["delete", String(args.id)], opts)).trim();
    },
  },
];

// Injected into compaction so the memory instructions survive context window resets.
export const MEMORY_INSTRUCTIONS = `## Persistent Memory (Mnemoteca)

You have persistent memory tools: memory_recall, memory_store, memory_delete,
memory_recall_global, memory_store_global.

When to use memory:
- Search memory when past context would help answer the user's request.
- Store concise summaries of important decisions, preferences, and patterns.
- Delete outdated memories when new decisions contradict them.
- Use **core** for facts that should always be in context (project architecture, key conventions, user preferences).
- Use **global** variants for cross-project preferences (coding style, tool choices).
- At the end of a session, store any relevant memories for future sessions.`;
