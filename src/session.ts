import type { MemoryHooks, Message } from "./types.js";

export interface SessionOptions {
  id?: string;
  messages?: Message[];
  memory?: MemoryHooks;
}

let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter += 1;
  return `session_${Date.now().toString(36)}_${sessionCounter}`;
}

/**
 * In-memory conversation session with optional persistence hooks.
 * Branching / compaction can layer on later via MemoryHooks.beforeModel.
 */
export class Session {
  readonly id: string;
  private messages: Message[];
  private readonly memory?: MemoryHooks;

  private constructor(id: string, messages: Message[], memory?: MemoryHooks) {
    this.id = id;
    this.messages = [...messages];
    if (memory) {
      this.memory = memory;
    }
  }

  static async create(options: SessionOptions = {}): Promise<Session> {
    const id = options.id ?? nextSessionId();
    let messages = options.messages ? [...options.messages] : [];
    if (options.memory?.load) {
      const loaded = await options.memory.load(id);
      if (loaded.length > 0) {
        messages = loaded;
      }
    }
    return new Session(id, messages, options.memory);
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  append(...msgs: Message[]): void {
    this.messages.push(...msgs);
  }

  async prepareForModel(): Promise<Message[]> {
    const current = this.getMessages();
    if (this.memory?.beforeModel) {
      return this.memory.beforeModel(current);
    }
    return current;
  }

  async persist(): Promise<void> {
    if (this.memory?.save) {
      await this.memory.save(this.id, this.getMessages());
    }
  }

  async afterTurn(): Promise<void> {
    if (this.memory?.afterTurn) {
      await this.memory.afterTurn(this.getMessages());
    }
  }
}
