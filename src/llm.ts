// Adapter-side transport: call the Anthropic Messages API and FORCE structured
// output via tool-use. The model must call our tool, and the API returns the
// tool input as an already-parsed JSON object — eliminating the freeform-JSON
// parse failures (e.g. unescaped Windows paths / code with backslashes).
// Uses global fetch (Node 18+/VS Code) → zero runtime deps to bundle.

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export async function callClaudeTool(
  key: string, model: string, system: string, user: string, tool: ClaudeTool,
): Promise<any> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Anthropic API ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data: any = await resp.json();
  const block = (data.content || []).find((b: any) => b && b.type === "tool_use");
  if (!block || !block.input) throw new Error("model returned no structured output");
  return block.input; // already a parsed JSON object
}
