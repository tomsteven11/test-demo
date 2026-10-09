import type { MemoryHooks, Message } from "./types.js";

/**
 * Simple in-process memory store keyed by session id.
 * Useful for tests and examples; swap for disk/DB in production.
 */
export class InMemoryStore {
  private readonly store = new Map<string, Message[]>();

  hooks(): MemoryHooks {
    return {
      load: (sessionId) => this.store.get(sessionId) ?? [],
      save: (sessionId, messages) => {
        this.store.set(sessionId, [...messages]);
      },
    };
  }

  get(sessionId: string): Message[] {
    return [...(this.store.get(sessionId) ?? [])];
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      this.store.delete(sessionId);
    } else {
      this.store.clear();
    }
  }
}

/**
 * Compose multiple memory hooks (e.g. persist + compaction).
 * Later hooks see the result of earlier beforeModel transforms.
 */
export function composeMemoryHooks(...hooks: MemoryHooks[]): MemoryHooks {
  return {
    async load(sessionId) {
      for (const h of hooks) {
        if (h.load) {
          const loaded = await h.load(sessionId);
          if (loaded.length > 0) {
            return loaded;
          }
        }
      }
      return [];
    },
    async save(sessionId, messages) {
      for (const h of hooks) {
        if (h.save) {
          await h.save(sessionId, messages);
        }
      }
    },
    async beforeModel(messages) {
      let current = messages;
      for (const h of hooks) {
        if (h.beforeModel) {
          current = await h.beforeModel(current);
        }
      }
      return current;
    },
    async afterTurn(messages) {
      for (const h of hooks) {
        if (h.afterTurn) {
          await h.afterTurn(messages);
        }
      }
    },
  };
}
