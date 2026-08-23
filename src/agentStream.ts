/**
 * A small SSE reader for POST-streamed responses. `EventSource` only
 * supports GET, and the message endpoint needs a body, so this reads the
 * stream manually via fetch — the same shape as any hand-rolled SSE client.
 */
export async function streamAgentTurn(
  applicationId: string,
  text: string | null,
  onEvent: (event: string, data: any) => void
): Promise<void> {
  const res = await fetch(`/api/applications/${applicationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text ?? "" }),
  });
  if (!res.ok || !res.body) throw new Error(`Agent service returned ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}
