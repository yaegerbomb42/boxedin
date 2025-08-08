# BoxedIn — Autonomous AI Agent with Sandboxed Tooling

BoxedIn is a modular AI agent that uses Google Gemini to plan, create, and reuse sandboxed tools (Python/Node) to achieve user goals. It persists memory, captures execution logs, and provides a CLI.

## Features

- Gemini-powered reasoning with long-context trimming
- Persistent memory: tool registry, conversation history, and run results
- Dynamic tool creation with manifests (name, purpose, inputs/outputs, usage)
- Sandboxed execution via Docker (preferred) or local fallback (cwd-confined)
- Supports Python and Node.js tools
- Iterative self-fix loop on failures
- CLI for running goals, inspecting status, and exporting/importing state

## Quick Start

1. Prereqs: Node 20+, optionally Docker. Set your Google Gemini API key.

```
export GEMINI_API_KEY=... # required
```

2. Install deps:

```
npm install
```

3. Run with a one-off goal:

```
npx boxedin run --goal "Create a Python tool that reverses input text and prints the result; then run it on 'sample'"
```

Or start interactive mode:

```
npx boxedin run
```

Data and sandbox live under `data/` and `sandbox/` by default. Use `--data` and `--sandbox` flags to change paths.

### Configuration flags

- `--model <name>`: Gemini model (default `gemini-1.5-flash`)
- `--timeout-ms <n>`: Sandbox execution timeout
- `--memory-mb <n>`: Sandbox memory limit
- `--cpu <n>`: Sandbox CPU share
- `--allow-network`: Allow network access inside sandbox (default off)

## CLI

- `boxedin run [--goal <text>]` — Run the agent once or interactively (if no goal).
- `boxedin status` — Show number of conversations, tools, and last run.
- `boxedin export` — Tar.gz memory and sandbox to stdout.
- `boxedin import <file.tgz>` — Import memory and sandbox from an archive.

## Architecture

- `src/core/gemini.mjs` — Gemini wrapper with basic context management
- `src/core/memory.mjs` — Persistent JSON memory, export/import
- `src/core/sandbox.mjs` — Sandboxed execution using Docker or local fallback
- `src/core/tools.mjs` — Tool manifest schema and load/save helpers
- `src/core/agent.mjs` — Agent loop: plan, create/execute tools, iterate on failures
- `src/cli.mjs` — CLI entry

### Tool Manifests

Each tool is stored under `sandbox/tools/<id>/` with a `manifest.json`:

```
{
	"id": "sentiment-123",
	"name": "Simple Sentiment",
	"purpose": "Counts positive/negative words",
	"language": "python", // or "node"
	"entry": "main.py",
	"inputs": [{"name": "text", "type": "string"}],
	"outputs": [{"name": "summary", "type": "json"}],
	"usage": "python main.py \"Hello world!\"",
	"createdAt": 0,
	"updatedAt": 0
}
```

## Security Notes

- When Docker is available, tools run inside a container with only the sandbox mounted.
- Fallback local mode confines cwd to the sandbox but is not a full security boundary.
- Resource limits are best-effort; adjust and harden for production.

## Extensibility

- Add support for more languages by extending the sandbox runner.
- Swap memory store for SQLite while preserving the same interface.
- Implement a web UI by calling the agent loop and exposing memory/logs.

## License

MIT
