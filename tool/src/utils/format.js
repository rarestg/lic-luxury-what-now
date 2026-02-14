export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value), window.location.origin);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {
    return "";
  }
  return "";
}

export function formatPrice(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : "0";
}

export function formatMetric(value, fallback = "?") {
  if (value === 0 || value) return escapeHtml(String(value));
  return fallback;
}

export function formatSqft(value, withUnit) {
  const num = Number(value);
  if (!Number.isFinite(num)) return withUnit ? "" : "N/A";
  return withUnit ? `${num.toLocaleString()} ft²` : num.toLocaleString();
}

export function nowIso() {
  return new Date().toISOString();
}

export function hashToHue(value) {
  const text = String(value ?? "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}
