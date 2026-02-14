import { getAppConfig } from "../config/runtime-config.js";

export async function geocodeWithEndpoint(raw, endpoint) {
  const url = new URL(endpoint, window.location.href);
  url.searchParams.set("address", raw);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Geocode endpoint returned HTTP ${res.status}`);

  const payload = await res.json();
  if (!payload) return null;
  if (typeof payload === "string") return payload.trim() || null;
  if (typeof payload.address === "string" && payload.address.trim()) return payload.address.trim();
  if (typeof payload.formattedAddress === "string" && payload.formattedAddress.trim())
    return payload.formattedAddress.trim();
  if (typeof payload.formatted_address === "string" && payload.formatted_address.trim())
    return payload.formatted_address.trim();
  if (payload.status === "OK" && Array.isArray(payload.results) && payload.results.length > 0) {
    const first = payload.results[0];
    if (first && typeof first.formatted_address === "string" && first.formatted_address.trim()) {
      return first.formatted_address.trim();
    }
  }
  return null;
}

export async function geocodeWithGoogle(raw, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(raw)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google geocoding returned HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.status === "OK" && Array.isArray(payload.results) && payload.results.length > 0) {
    const formatted = payload.results[0]?.formatted_address;
    if (typeof formatted === "string" && formatted.trim()) {
      return formatted.trim();
    }
  }
  return null;
}

export async function geocodeAddress(raw) {
  const cfg = getAppConfig();
  if (cfg.geocodeEndpoint) return geocodeWithEndpoint(raw, cfg.geocodeEndpoint);
  if (cfg.googleMapsApiKey) return geocodeWithGoogle(raw, cfg.googleMapsApiKey);
  throw new Error(
    "Geocoding is not configured. Set LIC_GEOCODE_ENDPOINT or LIC_GOOGLE_MAPS_API_KEY in .env, then run: node scripts/generate-tool-config.cjs",
  );
}
