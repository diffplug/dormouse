import { useState } from "react";

/** One email as its recipient's client gets it: the headers, the HTML in its
 * own document with no site style, and the plain-text part. */
export function EmailFrame({ from, to, replyTo, subject, html, text }: {
  from: string;
  to: readonly string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
}) {
  const [height, setHeight] = useState(0);
  const rows = [
    ["From", from],
    ["To", to.join(", ")],
    ...(replyTo ? [["Reply-To", replyTo]] : []),
    ["Subject", subject],
  ];
  return (
    <div style={{ background: "#fff", color: "#111", font: "14px/1.45 system-ui, sans-serif", maxWidth: 680 }}>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px", margin: 0, padding: 12, borderBottom: "1px solid #ccc" }}>
        {rows.map(([term, value]) => [
          <dt key={term} style={{ color: "#555" }}>{term}</dt>,
          <dd key={`${term}-value`} style={{ margin: 0, fontWeight: term === "Subject" ? 600 : 400 }}>{value}</dd>,
        ])}
      </dl>
      <iframe
        title={subject}
        sandbox="allow-same-origin"
        srcDoc={html}
        style={{ border: 0, display: "block", width: "100%", height }}
        onLoad={(event) => setHeight(event.currentTarget.contentDocument!.documentElement.scrollHeight)}
      />
      <pre style={{ margin: 0, padding: 12, borderTop: "1px solid #ccc", font: "12px/1.45 ui-monospace, monospace", whiteSpace: "pre-wrap" }}>{text}</pre>
    </div>
  );
}
