# opencode-mnemoteca

OpenCode plugin for **local persistent memory** using
[Mnemoteca](https://github.com/gandazgul/mnemoteca). It gives your AI coding
agent memory that persists across sessions. It is offline and does not use cloud
APIs.

## Prerequisites

Install the `mnemoteca` binary first:

```bash
curl -fsSL https://raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh | sh
mnemoteca setup
```

See the [Mnemoteca README](https://github.com/gandazgul/mnemoteca#installation)
for detailed setup instructions. On first use, Mnemoteca downloads its ML models,
approximately 500 MB one time.

Make sure the `mnemoteca` binary is in your `PATH`.

## Installation

Add the plugin to your OpenCode configuration:

```json
{
  "plugin": ["opencode-mnemoteca"]
}
```

For local development, build this repository checkout:

```bash
npm ci
npm run build
```

Then point OpenCode at the built file (`dist/index.js`), not at the repository
directory. See [OpenCode v2](#opencode-v2) for the v2 symlink.

## OpenCode v2

The package exports both plugin APIs from one entry point. OpenCode v1 loads the
existing `server` export and behaves exactly as before. OpenCode v2 loads the
`setup` export. Verified to load, register tools and execute them on OpenCode
v2.0.22.

On OpenCode 1.x, the object default export `{ id, server, setup }` is handled
from v1.3.4 onwards (OpenCode's migration guide documents 1.18.29+). Older 1.x
releases still load the tools via the named `MnemotecaPlugin` export but log a
load error for the object default export.

Install it in your v2 configuration under the `plugins` key (the legacy `plugin`
key is also read):

```json
{
  "plugins": ["opencode-mnemoteca"]
}
```

Until the package is published, build a local checkout (`npm ci && npm run build`)
and symlink the built **file** into the plugins directory:

```bash
ln -s /path/to/opencode-mnemoteca/dist/index.js ~/.config/opencode/plugins/mnemoteca.js
```

Do not point v2 at the repository **directory**: v2 only resolves `server` or
`index` entries inside a directory and does not read `package.json#main`, so the
plugin would be silently skipped. The relative `./core.js` and `./v2.js` imports
resolve through the symlink's real path.

On v2:

- The five `memory_*` tools are registered with `codemode: false`, so they stay
  directly callable instead of being folded into code mode.
- The memory instructions are injected through the `context` hook on every agent
  model request, so they are present at all times, including right after
  compaction. The plugin deliberately uses this hook instead of v2's
  `compaction` hook.
- The v2 plugin context has no logging facility, so the plugin logs nothing.

## Upgrade from opencode-mnemosyne

If you already used the old OpenCode plugin, stop OpenCode before you change the
configuration.

1. Migrate CLI data first if needed. Use the
   [Mnemoteca migration guide](https://github.com/gandazgul/mnemoteca/blob/main/docs/migrate-from-mnemosyne.md).
2. Add `opencode-mnemoteca` to the same OpenCode configuration scope that used
   `opencode-mnemosyne`.
3. Restart OpenCode and verify that the memory tools work. Store and recall a
   harmless test memory if needed.
4. Remove `opencode-mnemosyne` from that same configuration scope.
5. Restart OpenCode again.

Do not load the old and new plugins together for normal use. The agent-facing
`memory_*` tool names stay stable; only the plugin package and CLI command names
change.

Windows users must finish this replacement before restarting OpenCode. There is
no Windows `mnemosyne` compatibility shim, alias, copied executable, or renamed
executable.

## Memory tools

The agent-facing tool names stay stable. They describe memory capabilities, not
product branding.

| Tool | Purpose |
| --- | --- |
| `memory_recall` | Search project memory. |
| `memory_recall_global` | Search global memory. |
| `memory_store` | Store a project memory. Set `core=true` to tag it as core. |
| `memory_store_global` | Store a global memory. Set `core=true` to tag it as core. |
| `memory_delete` | Delete a memory by the numeric document ID shown in recall or list output. |

Project memory uses a collection name derived from the project directory name.
If that name is empty or `global`, the plugin uses `default`.

The project collection is initialized when the plugin loads. The global
collection is created on first use of `mnemoteca add -g` or the equivalent
global store tool.

## Commands taught to the agent

- Use `mnemoteca search -f plain [query]` and `mnemoteca search -g -f plain [query]` to search relevant memories.
- After significant decisions, use `mnemoteca add "memory content"` to save a concise fact. Use `mnemoteca add -g "memory content"` for cross-project preferences.
- Delete contradicted memories with `mnemoteca delete [memory id]` after storing the updated memory.
- Mark critical, always-relevant context as core with `-t core`. You can use repeated tags, such as `mnemoteca add "database is sqlite" -t core -t tech-stack`.

## How it works

Mnemoteca is a local document store with hybrid search:

- SQLite storage on your machine.
- BM25 plus vector search.
- Local ONNX Runtime inference.
- No cloud API calls.

The plugin calls the `mnemoteca` executable with argument arrays. It does not
own data storage, select databases, or run migrations.
