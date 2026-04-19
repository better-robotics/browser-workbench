// Thin wrapper around the local ai-proxies service at 127.0.0.1:7337. The proxy
// holds the OAuth token in Keychain so the browser never sees credentials.
// If it isn't running (other users, closed laptop, etc.) ask() returns null and
// callers should fall through to their canned message.
const PROXY_URL = "http://127.0.0.1:7337/v1/messages";
const MODEL = "claude-sonnet-4-6";
const TIMEOUT_MS = 6000;

export async function ask(userText, { system, maxTokens = 200 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userText }],
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const text = json?.content?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;  // proxy unreachable, timeout, aborted, or malformed response
  } finally {
    clearTimeout(timer);
  }
}
