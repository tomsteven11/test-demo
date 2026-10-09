/**
 * Minimal runnable example: mock model + echo/add tools + event streaming.
 * Run: npm run example
 */
import {
  Agent,
  defineTool,
  InMemoryStore,
  type AgentEvent,
  type ModelStreamFn,
} from "../src/index.js";

const echo = defineTool({
  name: "echo",
  description: "Echo back a string",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to echo" },
    },
    required: ["text"],
  },
  execute: ({ text }) => ({ content: String(text) }),
});

const add = defineTool({
  name: "add",
  description: "Add two numbers",
  parameters: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
  },
  execute: ({ a, b }) => {
    const sum = Number(a) + Number(b);
    return { content: String(sum) };
  },
});

/**
 * Deterministic mock model: first turn requests tools, second turn answers.
 * Swap for a real LLM stream adapter in production.
 */
const mockModel: ModelStreamFn = async ({ messages, onDelta }) => {
  const toolResults = messages.filter((m) => m.role === "tool");
  if (toolResults.length === 0) {
    const chunks = ["I'll ", "use ", "tools ", "to ", "help.\n"];
    for (const chunk of chunks) {
      onDelta?.(chunk);
    }
    return {
      role: "assistant",
      content: [
        { type: "text", text: "I'll use tools to help." },
        {
          type: "tool_call",
          id: "call_echo",
          name: "echo",
          arguments: { text: "hello from test-demo" },
        },
        {
          type: "tool_call",
          id: "call_add",
          name: "add",
          arguments: { a: 2, b: 3 },
        },
      ],
    };
  }

  const summary = toolResults
    .map((m) => `${m.name}=${m.content}`)
    .join(", ");
  const reply = `Done. Results: ${summary}`;
  onDelta?.(reply);
  return { role: "assistant", content: reply };
};

function formatEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case "agent_start":
      return `[agent_start] session=${event.sessionId}`;
    case "turn_start":
      return `[turn_start] #${event.turn}`;
    case "text_delta":
      return null; // streamed live below
    case "tool_execution_start":
      return `[tool] ${event.name}(${JSON.stringify(event.arguments)})`;
    case "tool_execution_end":
      return `[tool done] ${event.name} → ${event.result.content}`;
    case "turn_end":
      return `[turn_end] #${event.turn} tools=${event.toolResults.length}`;
    case "agent_end":
      return `[agent_end] produced=${event.messages.length} messages`;
    case "error":
      return `[error] ${event.error.message}`;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const store = new InMemoryStore();
  const agent = new Agent({
    systemPrompt: "You are a demo agent for the test-demo framework.",
    model: mockModel,
    tools: [echo, add],
    sessionId: "demo-session",
    memory: store.hooks(),
    maxTurns: 4,
  });

  process.stdout.write("Streaming text: ");
  agent.subscribe((event) => {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
      return;
    }
    const line = formatEvent(event);
    if (line) {
      console.log(line);
    }
  });

  const produced = await agent.prompt("Please echo a greeting and add 2+3.");
  console.log("\n--- session transcript ---");
  for (const msg of agent.getMessages()) {
    const body =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    console.log(`${msg.role}: ${body}`);
  }
  console.log(`\nLoop produced ${produced.length} new messages.`);
  console.log(
    `Persisted messages in store: ${store.get("demo-session").length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
