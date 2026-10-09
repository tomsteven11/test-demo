import { EventBus, type AgentEventListener } from "./events.js";
import { runAgentLoop } from "./loop.js";
import { Session } from "./session.js";
import { ToolRegistry } from "./tools.js";
import type { AgentOptions, Message, Tool } from "./types.js";

/**
 * High-level agent runtime: owns session, tools, event bus, and the prompt loop.
 */
export class Agent {
  private readonly options: AgentOptions;
  private readonly tools: ToolRegistry;
  private readonly bus = new EventBus();
  private session: Session | null = null;
  private running = false;

  constructor(options: AgentOptions) {
    this.options = options;
    this.tools = new ToolRegistry(options.tools ?? []);
  }

  /** Subscribe to streaming / lifecycle events. Returns an unsubscribe fn. */
  subscribe(listener: AgentEventListener): () => void {
    return this.bus.subscribe(listener);
  }

  registerTool(tool: Tool): this {
    this.tools.register(tool);
    return this;
  }

  getSession(): Session | null {
    return this.session;
  }

  getMessages(): Message[] {
    return this.session?.getMessages() ?? [];
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Ensure a session exists (lazy create / resume via memory.load). */
  async ensureSession(): Promise<Session> {
    if (!this.session) {
      this.session = await Session.create({
        ...(this.options.sessionId !== undefined
          ? { id: this.options.sessionId }
          : {}),
        ...(this.options.memory !== undefined
          ? { memory: this.options.memory }
          : {}),
      });
    }
    return this.session;
  }

  /**
   * Append a user message and run the agent loop until the model stops
   * calling tools or maxTurns is reached.
   */
  async prompt(
    text: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Message[]> {
    if (this.running) {
      throw new Error("Agent is already running a turn");
    }

    const session = await this.ensureSession();
    const userMessage: Message = { role: "user", content: text };
    session.append(userMessage);
    await this.bus.emit(
      { type: "message_start", message: userMessage },
      opts.signal,
    );
    await this.bus.emit(
      { type: "message_end", message: userMessage },
      opts.signal,
    );

    this.running = true;
    try {
      return await runAgentLoop({
        model: this.options.model,
        tools: this.tools,
        session,
        bus: this.bus,
        maxTurns: this.options.maxTurns ?? 8,
        ...(this.options.systemPrompt !== undefined
          ? { systemPrompt: this.options.systemPrompt }
          : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } finally {
      this.running = false;
    }
  }
}
