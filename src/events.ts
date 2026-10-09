import type { Message, ToolResult } from "./types.js";

/** Lifecycle and streaming events emitted by the agent runtime. */
export type AgentEvent =
  | { type: "agent_start"; sessionId: string }
  | { type: "agent_end"; sessionId: string; messages: Message[] }
  | { type: "turn_start"; turn: number }
  | {
      type: "turn_end";
      turn: number;
      assistant: Message;
      toolResults: Message[];
    }
  | { type: "message_start"; message: Message }
  | { type: "message_end"; message: Message }
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      name: string;
      result: ToolResult;
    }
  | { type: "error"; error: Error };

export type AgentEventListener = (
  event: AgentEvent,
  signal?: AbortSignal,
) => void | Promise<void>;

/** Tiny pub/sub used by Agent and the loop. */
export class EventBus {
  private readonly listeners = new Set<AgentEventListener>();

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(event: AgentEvent, signal?: AbortSignal): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event, signal);
    }
  }
}
