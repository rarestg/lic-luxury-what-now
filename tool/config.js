(function applyDefaultConfig() {
  var existing = window.LIC_CONFIG && typeof window.LIC_CONFIG === 'object'
    ? window.LIC_CONFIG
    : {};

  window.LIC_CONFIG = Object.assign({
    geocodeEndpoint: '',
    googleMapsApiKey: '',
    apiBaseUrl: '',
    useApiAssertions: false
  }, existing);
})();
