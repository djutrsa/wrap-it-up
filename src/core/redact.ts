// Best-effort secret redaction. NEVER claim completeness.
// Shared by the recorder (before writing the log) and the core (before any send).

const PATTERNS: [RegExp, string][] = [
  // PEM private-key blocks (whole block; also a lone header in case the block is clipped)
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
  // known provider key/token formats
  [/sk[-_](?:test_|live_|ant-)?[A-Za-z0-9_\-]{10,}/g, "[redacted-key]"],
  [/SG\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}/g, "[redacted-sendgrid-key]"],
  [/xox[baprs]-?[A-Za-z0-9-]{8,}/g, "[redacted-slack-token]"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-gh-token]"],
  [/AIza[0-9A-Za-z_\-]{20,}/g, "[redacted-google-key]"],
  [/A(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[A-Z0-9]{12,}/g, "[redacted-aws-key]"],
  [/\b(?:AC|SK|AU|SM|MM|PN)[0-9a-zA-Z]{30,}\b/g, "[redacted-sid]"],
  [/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}/g, "[redacted-jwt]"],
  [/bearer\s+[A-Za-z0-9._\-]{12,}/gi, "bearer [redacted]"],
  // connection strings carrying credentials (user:pass@host)
  [/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`]*:[^\s"'`@]+@[^\s"'`]+/gi, "[redacted-conn-string]"],
  // Credential assignments — keep the name, redact the value. "token"/"auth" alone are too
  // common (TokenBucket, lexer tokens), so only QUALIFIED forms count; and we only redact a
  // value that is a QUOTED literal (A) or a .env-style KEY=value (B), never a code reference.
  // (A) quoted: NAME: "secret"  /  NAME = 'secret'
  [/(\b[A-Za-z0-9_.]*(?:api[_-]?key|apikey|access[_-]?key|accesskey|secret|password|passwd|passphrase|private[_-]?key|privatekey|auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?token|bearer[_-]?token|session[_-]?token|client[_-]?secret|webhook[_-]?secret|credential)[A-Za-z0-9_.]*\s*[:=]\s*["'`])[^"'`\n]{4,}/gi, "$1[redacted]"],
  // (B) .env-style: NAME=value (no spaces, unquoted literal; skip env-var reads)
  [/(\b[A-Za-z0-9_.]*(?:api[_-]?key|apikey|access[_-]?key|accesskey|secret|password|passwd|passphrase|private[_-]?key|privatekey|auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?token|bearer[_-]?token|session[_-]?token|client[_-]?secret|webhook[_-]?secret|credential)[A-Za-z0-9_.]*=)(?!process\.env|os\.environ|os\.getenv|getenv|["'`])[^\s"'`,;)\]}]{8,}/gi, "$1[redacted]"],
];

export function redact(s: string | undefined | null): string {
  if (!s) return "";
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function clip(s: string | undefined | null, head = 700, tail = 300): string {
  const str = (s || "").replace(/\r/g, "");
  if (str.length <= head + tail + 40) return str;
  return str.slice(0, head) + `\n...[clipped ${str.length - head - tail} chars]...\n` + str.slice(-tail);
}
