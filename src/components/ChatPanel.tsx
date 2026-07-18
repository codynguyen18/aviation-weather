"use client";

import { useEffect, useRef, useState } from "react";

// Grounded briefing chat (PLAN.md §15.5): every AI reply is validated
// server-side before display, and every claim carries a citation chip that
// opens the raw official product in the source inspector.

interface Citation {
  tag: number;
  sourceRecordId: string;
  label: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  isFallback: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  generating: "Thinking…",
  checking: "Checking the answer against sources…",
  regenerating: "First draft failed checks — regenerating…",
  fallback: "Falling back to the deterministic summary…",
};

/** Render reply text with [src:N] tags replaced by clickable chips. */
function MessageBody(props: {
  content: string;
  citations: Citation[];
  onInspect: (recordId: string) => void;
}) {
  const byTag = new Map(props.citations.map((c) => [c.tag, c]));
  const parts = props.content.split(/(\[src:\d+\])/g);
  return (
    <span style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((part, i) => {
        const m = /^\[src:(\d+)\]$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        const cite = byTag.get(Number(m[1]));
        if (!cite) return <span key={i} className="muted">{part}</span>;
        return (
          <button
            key={i}
            onClick={() => props.onInspect(cite.sourceRecordId)}
            title={cite.label}
            style={{
              fontSize: 10.5, padding: "0 6px", borderRadius: 999,
              margin: "0 2px", verticalAlign: "text-top",
            }}
          >
            {cite.label}
          </button>
        );
      })}
    </span>
  );
}

export default function ChatPanel(props: {
  snapshotId: string;
  onInspect: (recordId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/briefings/${props.snapshotId}/chat`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        setConversationId(d.conversationId);
        setMessages(
          (d.messages ?? []).map((m: Record<string, unknown>) => ({
            role: m.role,
            content: m.content,
            citations: Array.isArray(m.citations) ? m.citations : [],
            isFallback: Boolean(m.is_fallback),
          })),
        );
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [props.snapshotId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setError(null);
    setMessages((ms) => [...ms, { role: "user", content: message, citations: [], isFallback: false }]);
    setBusy("Thinking…");
    try {
      const res = await fetch(`/api/briefings/${props.snapshotId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      // Parse the SSE stream: status updates, then one final message.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const dataRaw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !dataRaw) continue;
          const data = JSON.parse(dataRaw);
          if (event === "status") {
            setBusy(STATUS_LABEL[data.status] ?? "Working…");
          } else if (event === "final") {
            setConversationId(data.conversationId);
            setMessages((ms) => [
              ...ms,
              {
                role: "assistant",
                content: data.reply.content,
                citations: data.reply.citations ?? [],
                isFallback: Boolean(data.reply.isFallback),
              },
            ]);
            finished = true;
          } else if (event === "error") {
            throw new Error(data.error);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)} style={{ justifySelf: "start" }}>
        💬 Ask about this briefing
      </button>
    );
  }

  return (
    <div className="panel" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b>Ask about this briefing</b>
        <span className="muted" style={{ fontSize: 11.5 }}>
          answers come only from this briefing&apos;s sources — every claim is checked and cited
        </span>
        <button onClick={() => setOpen(false)} style={{ marginLeft: "auto" }}>—</button>
      </div>

      <div style={{ display: "grid", gap: 8, maxHeight: 340, overflowY: "auto" }}>
        {messages.length === 0 && (
          <span className="muted" style={{ fontSize: 13 }}>
            Try: &ldquo;Why is my trip rated red?&rdquo; · &ldquo;What changed since my last
            briefing?&rdquo; · &ldquo;What&apos;s the wind doing on the Rock Springs leg?&rdquo;
          </span>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              justifySelf: m.role === "user" ? "end" : "start",
              maxWidth: "85%",
              background: m.role === "user" ? "#1c2733" : "#121a23",
              border: "1px solid #223",
              borderRadius: 10,
              padding: "8px 10px",
              fontSize: 13.5,
            }}
          >
            {m.isFallback && (
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                ⚙ deterministic summary (AI answer failed checks or was unavailable)
              </div>
            )}
            <MessageBody content={m.content} citations={m.citations} onInspect={props.onInspect} />
          </div>
        ))}
        {busy && <span className="muted" style={{ fontSize: 12.5 }}>{busy}</span>}
        {error && <div className="partial-banner">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about this briefing…"
          maxLength={2000}
          style={{ flex: 1 }}
          disabled={busy !== null}
        />
        <button className="primary" type="submit" disabled={busy !== null || !input.trim()}>
          Send
        </button>
      </form>
      <span className="muted" style={{ fontSize: 11 }}>
        Advisory only — the assistant explains the stored briefing; it never adds
        outside weather data and never makes the go/no-go call.
      </span>
    </div>
  );
}
