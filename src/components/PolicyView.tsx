import React from "react";

interface PolicyViewProps {
  active: boolean;
  document: string;
}

/**
 * Shown alongside the chat so a demo audience can read the same document the
 * agent read, and check the §-references it quotes back to them. The text
 * comes from GET /api/policy — the server-side, mammoth-parsed contents of
 * config/policy.docx — not a local import, since the document is now
 * business-maintained and lives outside the client bundle entirely.
 */
export default function PolicyView({ active, document }: PolicyViewProps) {
  return (
    <section className="pane policy" data-on={active ? 1 : 0}>
      <div className="plabel">Governing document</div>
      <pre>{document}</pre>
    </section>
  );
}
