(function applyDefaultConfig() {
  /** @type {Window & { LIC_CONFIG?: Record<string, unknown> }} */
  const win = window;
  const existing = win.LIC_CONFIG && typeof win.LIC_CONFIG === "object" ? win.LIC_CONFIG : {};

  win.LIC_CONFIG = Object.assign(
    {
      geocodeEndpoint: "",
      googleMapsApiKey: "",
      apiBaseUrl: "",
      useApiAssertions: false,
    },
    existing,
  );
})();
