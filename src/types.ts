/** Role of a conversation message. */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Text content block in an assistant message. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Tool-call content block produced by the model. */
export interface ToolCallContent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ToolCallContent;

/** A single message in the agent conversation. */
export interface Message {
  role: MessageRole;
  /** Plain text for user/system/tool; structured blocks for assistant. */
  content: string | ContentBlock[];
  /** Links a tool result to its tool_call id. */
  toolCallId?: string;
  name?: string;
}

/** JSON-schema-ish parameter description for a tool. */
export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Result returned from a tool invocation. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Executable tool definition. */
export interface Tool<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

/** Runtime context passed into tool handlers. */
export interface ToolContext {
  signal?: AbortSignal;
  sessionId: string;
}

/**
 * Pluggable model stream. Implementations call `onDelta` for text chunks
 * and return the final assistant message (with optional tool calls).
 */
export interface ModelStreamRequest {
  systemPrompt?: string;
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export type ModelStreamFn = (req: ModelStreamRequest) => Promise<Message>;

/** Optional hooks for session persistence / memory. */
export interface MemoryHooks {
  /** Load prior messages when a session is created or resumed. */
  load?(sessionId: string): Promise<Message[]> | Message[];
  /** Persist after each completed turn (assistant + tool results). */
  save?(sessionId: string, messages: Message[]): Promise<void> | void;
  /** Transform context before each model call (e.g. compaction). */
  beforeModel?(messages: Message[]): Promise<Message[]> | Message[];
  /** Observe after tools run for a turn. */
  afterTurn?(messages: Message[]): Promise<void> | void;
}

export interface AgentOptions {
  systemPrompt?: string;
  tools?: Tool[];
  model: ModelStreamFn;
  sessionId?: string;
  memory?: MemoryHooks;
  /** Max tool-calling turns before the loop stops. Default 8. */
  maxTurns?: number;
}
