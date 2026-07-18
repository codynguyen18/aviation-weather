import Anthropic from "@anthropic-ai/sdk";

// Provider-agnostic LLM adapter (PLAN.md §12.2). The chat orchestrator only
// knows this interface; the Anthropic implementation is the default provider
// and the stub keeps every test deterministic and offline.

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  run(input: unknown): Promise<string>;
}

export interface LlmRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tools: LlmToolDef[];
  maxTokens?: number;
  onDelta?: (text: string) => void;
}

export interface LlmResult {
  text: string;
  toolTranscript: { name: string; input: unknown; output: string }[];
}

export interface LlmAdapter {
  name: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

const MAX_TOOL_ROUNDS = 6;

/** Default provider: Anthropic Messages API with a read-only tool loop. */
export class AnthropicAdapter implements LlmAdapter {
  name = "anthropic";
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model: string = "claude-opus-4-8",
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    const byName = new Map(req.tools.map((t) => [t.name, t]));
    const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const texts: string[] = [];
    const toolTranscript: LlmResult["toolTranscript"] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Streaming keeps long answers inside request timeouts and feeds the
      // SSE channel; adaptive thinking is the current-API default for
      // anything non-trivial.
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: req.maxTokens ?? 1600,
        thinking: { type: "adaptive" },
        system: req.system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      });
      if (req.onDelta) stream.on("text", req.onDelta);
      const msg = await stream.finalMessage();

      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text);
      }
      if (msg.stop_reason !== "tool_use") break;

      // Execute requested tools and hand results back; thinking blocks must
      // ride along unchanged in the assistant turn.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type !== "tool_use") continue;
        const tool = byName.get(block.name);
        let output: string;
        try {
          output = tool
            ? await tool.run(block.input)
            : `error: unknown tool ${block.name}`;
        } catch (err) {
          output = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        toolTranscript.push({ name: block.name, input: block.input, output });
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: results });
    }

    return { text: texts.join("\n\n"), toolTranscript };
  }
}

export type StubTurn =
  | string
  | ((req: LlmRequest) => { text: string; toolCalls?: { name: string; input: unknown }[] });

/** Test double: replays scripted replies and records what it was asked. */
export class StubAdapter implements LlmAdapter {
  name = "stub";
  requests: LlmRequest[] = [];
  private queue: StubTurn[];
  constructor(turns: StubTurn[]) {
    this.queue = [...turns];
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req);
    const turn = this.queue.shift();
    if (turn === undefined) throw new Error("StubAdapter: no scripted turns left");
    const resolved = typeof turn === "function" ? turn(req) : { text: turn };
    const toolTranscript: LlmResult["toolTranscript"] = [];
    for (const call of resolved.toolCalls ?? []) {
      const tool = req.tools.find((t) => t.name === call.name);
      const output = tool ? await tool.run(call.input) : `error: unknown tool ${call.name}`;
      toolTranscript.push({ name: call.name, input: call.input, output });
    }
    req.onDelta?.(resolved.text);
    return { text: resolved.text, toolTranscript };
  }
}
