import { buildApiUrl } from "../config/runtime-config.js";

export async function postAssertionToApi(listingId, address) {
  const res = await fetch(buildApiUrl("/api/assertions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      listingId: String(listingId),
      address: String(address),
      source: "manual_ui",
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload || payload.ok !== true) {
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : `API request failed (HTTP ${res.status})`;
    throw new Error(message);
  }
  return payload;
}
