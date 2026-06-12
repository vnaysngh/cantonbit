/**
 * Observability — fire-and-forget operational alerts to a webhook.
 *
 * Set ALERT_WEBHOOK_URL to a Slack/Discord incoming-webhook (or any endpoint that
 * accepts `{ text }`). When unset, alerts fall back to console.error so nothing is
 * lost in dev. Alerts are best-effort: a webhook failure NEVER throws into the
 * caller's flow (this is monitoring, not control).
 *
 * Use for: failed claims, solver insolvency, stuck/expired swaps, sweep errors —
 * the things an operator needs to know about but that don't have a user in the loop.
 */

const WEBHOOK = process.env.ALERT_WEBHOOK_URL;

export type AlertLevel = "info" | "warn" | "error";

const EMOJI: Record<AlertLevel, string> = { info: "ℹ️", warn: "⚠️", error: "🔴" };

/** Send an operational alert. Never throws. */
export async function alert(
  level: AlertLevel,
  title: string,
  fields?: Record<string, string | number | undefined>,
): Promise<void> {
  const parts = [`${EMOJI[level]} *${title}*`];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v !== undefined && v !== "") parts.push(`• ${k}: \`${v}\``);
  }
  const text = parts.join("\n");

  // Always log locally so dev/console retains the signal.
  (level === "error" ? console.error : console.warn)(`[alert] ${title}`, fields ?? "");

  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text` works for Slack + Discord incoming webhooks; harmless elsewhere.
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Monitoring must never break the caller — swallow.
  }
}
