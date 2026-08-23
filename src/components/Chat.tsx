import React, { useState, useRef, useEffect } from "react";
import type { ChatMsg } from "../../server/domain/types.js";

interface Fixture {
  id: string;
  name: string;
}

interface ChatProps {
  active: boolean;
  msgs: ChatMsg[];
  busy: boolean;
  /** Transient wait-time line, shown with the typing indicator. Not a message:
   *  it is never added to the transcript and vanishes when the reply lands. */
  waiting: { intro: string; text: string } | null;
  /** The reply mid-generation. Rendered as a live bubble; `msgs` gains the
   *  finished message separately, so this is never appended to it. */
  streaming: string | null;
  onSend: (text: string) => void;
  fixtures: Fixture[];
  showFixtures: boolean;
}

/**
 * Pure presentation. Knows nothing about the agent, tools or policy — it
 * renders a message list and hands typed text upward. This is the boundary
 * that makes the React Native port cheap: only this file's primitives change.
 */
export default function Chat({ active, msgs, busy, waiting, streaming, onSend, fixtures, showFixtures }: ChatProps) {
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy, waiting, streaming]);

  const submit = (text?: string) => {
    onSend(text ?? input);
    if (text === undefined) setInput("");
  };

  return (
    <section className="pane chat" data-on={active ? 1 : 0}>
      <div className="msgs">
        {msgs.map((m, i) => (
          <div key={i} className={"b " + (m.role === "agent" ? "a" : m.role === "customer" ? "u" : "s")}>
            {m.text}
          </div>
        ))}
        {streaming !== null && <div className="b a stream">{streaming}</div>}
        {busy && streaming === null && (
          <div className="wait">
            <div className="typing"><i /><i /><i /></div>
            {waiting && (
              <div className="ambient">
                <p className="ambient-intro">{waiting.intro}</p>
                <p className="ambient-body">{waiting.text}</p>
              </div>
            )}
          </div>
        )}
        <div ref={end} />
      </div>

      {showFixtures && (
        <div className="chips">
          {fixtures.map((f) => (
            <button key={f.id} onClick={() => submit(f.id)}>{f.id} · {f.name}</button>
          ))}
        </div>
      )}

      <div className="compose">
        <input
          value={input}
          placeholder="Type a message"
          aria-label="Message"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={() => submit()} disabled={busy || !input.trim()}>Send</button>
      </div>
    </section>
  );
}
