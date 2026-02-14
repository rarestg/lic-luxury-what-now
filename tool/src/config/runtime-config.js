export function getAppConfig() {
  /** @type {Window & { LIC_CONFIG?: any }} */
  const win = window;
  /** @type {any} */
  const cfg = win.LIC_CONFIG && typeof win.LIC_CONFIG === "object" ? win.LIC_CONFIG : {};

  return {
    geocodeEndpoint: String(cfg.geocodeEndpoint || "").trim(),
    googleMapsApiKey: String(cfg.googleMapsApiKey || "").trim(),
    apiBaseUrl: String(cfg.apiBaseUrl || "").trim(),
    useApiAssertions: Boolean(cfg.useApiAssertions),
  };
}

export function isGeocodeConfigured() {
  const cfg = getAppConfig();
  return Boolean(cfg.geocodeEndpoint || cfg.googleMapsApiKey);
}

export function getApiBaseUrl() {
  const cfg = getAppConfig();
  if (!cfg.apiBaseUrl) return "";
  return cfg.apiBaseUrl.replace(/\/+$/, "");
}

export function isApiAssertionsEnabled() {
  const cfg = getAppConfig();
  return Boolean(cfg.useApiAssertions);
}

export function buildApiUrl(path) {
  const base = getApiBaseUrl();
  const p = String(path || "");
  const cleanPath = p.startsWith("/") ? p : `/${p}`;
  return `${base}${cleanPath}`;
}
