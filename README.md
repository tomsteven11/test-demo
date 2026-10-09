# test-demo

TypeScript agent-development framework: agent loop, tool registration, sessions/memory hooks, and streaming events.

## Setup

```bash
npm install
npm run build
```

## Run the example

```bash
npm run example
```

The example uses a deterministic mock model (no API key) that calls `echo` and `add` tools, streams `text_delta` events, and persists the session via `InMemoryStore`.

## Quick start

```ts
import { Agent, defineTool, type ModelStreamFn } from "test-demo";

const greet = defineTool({
  name: "greet",
  description: "Greet someone",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  execute: ({ name }) => ({ content: `Hello, ${name}!` }),
});

const model: ModelStreamFn = async ({ onDelta }) => {
  onDelta?.("Hi!");
  return { role: "assistant", content: "Hi!" };
};

const agent = new Agent({
  systemPrompt: "Be helpful.",
  model,
  tools: [greet],
});

agent.subscribe((e) => {
  if (e.type === "text_delta") process.stdout.write(e.delta);
});

await agent.prompt("Say hello");
```

## Package layout

| Path | Role |
|------|------|
| `src/agent.ts` | High-level `Agent` (prompt, subscribe, tools) |
| `src/loop.ts` | Core tool-calling loop + event emission |
| `src/tools.ts` | `ToolRegistry` / `defineTool` |
| `src/session.ts` | Conversation session |
| `src/memory.ts` | Memory hooks + in-memory store |
| `src/events.ts` | Event types and bus |
| `src/types.ts` | Shared types |
| `examples/basic.ts` | Runnable demo |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile `src/` → `dist/` |
| `npm run example` | Run the basic example with `tsx` |
| `npm run typecheck` | Typecheck without emit |
