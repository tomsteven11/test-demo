import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Registry for discovering and invoking tools by name. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(initial: Tool[] = []) {
    for (const tool of initial) {
      this.register(tool);
    }
  }

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Unknown tool: ${name}`,
        isError: true,
      };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: message, isError: true };
    }
  }
}

/** Helper to define a typed tool without boilerplate. */
export function defineTool<TArgs extends Record<string, unknown>>(
  tool: Tool<TArgs>,
): Tool<TArgs> {
  return tool;
}
