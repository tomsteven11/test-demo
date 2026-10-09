import type { EventBus } from "./events.js";
import type { Session } from "./session.js";
import type { ToolRegistry } from "./tools.js";
import type {
  ContentBlock,
  Message,
  ModelStreamFn,
  ToolCallContent,
} from "./types.js";

export interface LoopConfig {
  systemPrompt?: string;
  model: ModelStreamFn;
  tools: ToolRegistry;
  session: Session;
  bus: EventBus;
  maxTurns: number;
  signal?: AbortSignal;
}

function isToolCall(block: ContentBlock): block is ToolCallContent {
  return block.type === "tool_call";
}

function extractToolCalls(message: Message): ToolCallContent[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter(isToolCall);
}

/**
 * Core agent loop: stream model → execute tools → repeat until done or maxTurns.
 * Emits events on the shared EventBus for UI / logging subscribers.
 */
export async function runAgentLoop(config: LoopConfig): Promise<Message[]> {
  const { systemPrompt, model, tools, session, bus, maxTurns, signal } = config;
  const produced: Message[] = [];

  await bus.emit({ type: "agent_start", sessionId: session.id }, signal);

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      signal?.throwIfAborted();
      await bus.emit({ type: "turn_start", turn }, signal);

      const contextMessages = await session.prepareForModel();
      const assistant = await model({
        messages: contextMessages,
        tools: tools.list(),
        onDelta: (delta) => {
          void bus.emit({ type: "text_delta", delta }, signal);
        },
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });

      await bus.emit({ type: "message_start", message: assistant }, signal);
      session.append(assistant);
      produced.push(assistant);
      await bus.emit({ type: "message_end", message: assistant }, signal);

      const calls = extractToolCalls(assistant);
      const toolResults: Message[] = [];

      for (const call of calls) {
        await bus.emit(
          {
            type: "tool_execution_start",
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
          },
          signal,
        );

        const result = await tools.execute(
          call.name,
          call.arguments,
          signal !== undefined
            ? { sessionId: session.id, signal }
            : { sessionId: session.id },
        );

        const toolMessage: Message = {
          role: "tool",
          content: result.content,
          toolCallId: call.id,
          name: call.name,
        };
        session.append(toolMessage);
        produced.push(toolMessage);
        toolResults.push(toolMessage);

        await bus.emit(
          {
            type: "tool_execution_end",
            toolCallId: call.id,
            name: call.name,
            result,
          },
          signal,
        );
        await bus.emit({ type: "message_end", message: toolMessage }, signal);
      }

      await session.persist();
      await session.afterTurn();
      await bus.emit(
        { type: "turn_end", turn, assistant, toolResults },
        signal,
      );

      if (calls.length === 0) {
        break;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await bus.emit({ type: "error", error }, signal);
    throw error;
  } finally {
    await bus.emit(
      { type: "agent_end", sessionId: session.id, messages: produced },
      signal,
    );
  }

  return produced;
}
