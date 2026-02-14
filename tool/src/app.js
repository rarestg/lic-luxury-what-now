import {
  buildApiUrl,
  isApiAssertionsEnabled,
  isGeocodeConfigured,
} from "./config/runtime-config.js";
import {
  applyGraphData,
  getComponentConflictAddresses,
  getComponentForListing,
  getCurrentComponent,
} from "./model/graph.js";
import { postAssertionToApi } from "./services/assertions-api.js";
import { geocodeAddress } from "./services/geocode.js";
import {
  appState,
  getListingById,
  getListingState,
  loadState,
  mergeAssignments,
  normalizeListingState,
  saveState,
  setListings,
} from "./state/store.js";
import { renderListingDetails } from "./ui/details.js";
import { renderSidebar, updateViewModeButtons } from "./ui/sidebar.js";
import { nowIso } from "./utils/format.js";

function hideEmptyState() {
  const emptyState = document.getElementById("empty-state");
  if (emptyState) emptyState.style.display = "none";
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function selectListing(id) {
  const listingId = String(id || "");
  appState.selectedId = listingId;
  const listing = getListingById(listingId);
  if (!listing) return;

  hideEmptyState();
  const main = document.getElementById("main");
  main.innerHTML = renderListingDetails(listingId);
  renderSidebar();
}

async function geocodeAndFill() {
  const inputEl = document.getElementById("address-input");
  const btnEl = document.getElementById("geocode-btn");
  if (!(inputEl instanceof HTMLInputElement) || !(btnEl instanceof HTMLButtonElement)) return;
  if (!inputEl.value.trim()) return;
  if (!isGeocodeConfigured()) {
    alert("Geocoding is disabled. Configure .env, then run: node scripts/generate-tool-config.cjs");
    return;
  }
  btnEl.textContent = "Normalizing...";
  btnEl.disabled = true;
  try {
    const cleaned = await geocodeAddress(inputEl.value.trim());
    if (cleaned) {
      inputEl.value = cleaned;
    } else {
      alert("Could not geocode that address. Try being more specific.");
    }
  } catch (e) {
    alert(`Geocoding failed: ${e.message}`);
  }
  btnEl.textContent = "Normalize";
  btnEl.disabled = false;
}

async function saveAddress(id) {
  const inputEl = document.getElementById("address-input");
  if (!(inputEl instanceof HTMLInputElement)) return;

  const address = inputEl.value.trim();
  if (!address) return;

  const key = String(id);
  const ls = getListingState(key);
  ls.address = address;
  ls.resolved = true;
  ls.source = "direct";
  ls.confidence = 1.0;
  ls.updatedAt = nowIso();

  if (isApiAssertionsEnabled()) {
    try {
      const payload = await postAssertionToApi(key, address);
      if (payload.assignments && typeof payload.assignments === "object") {
        mergeAssignments(payload.assignments);
      }
      if (payload.conflict) {
        alert("Saved, but component has conflicting direct addresses. Inference was limited.");
      }
    } catch (e) {
      alert(`API save failed, kept local save only: ${e.message}`);
    }
  }

  saveState();
  selectListing(key);
}

function editAddress(id) {
  const ls = getListingState(id);
  ls.resolved = false;
  ls.source = "";
  ls.confidence = null;
  ls.updatedAt = nowIso();
  saveState();
  selectListing(id);
}

function saveNotes(id) {
  const textarea = document.getElementById("notes-input");
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const ls = getListingState(id);
  ls.notes = textarea.value;
  saveState();
  renderSidebar();
}

function setSidebarMode(mode) {
  appState.sidebarMode = mode === "clustered" ? "clustered" : "flat";
  if (appState.sidebarMode !== "clustered") appState.focusedClusterKey = "";
  renderSidebar();
}

function focusCluster(clusterKey) {
  const key = String(clusterKey || "");
  if (!key) return;
  appState.focusedClusterKey = appState.focusedClusterKey === key ? "" : key;
  if (appState.sidebarMode !== "clustered") appState.sidebarMode = "clustered";
  renderSidebar();
}

function clearClusterFocus() {
  appState.focusedClusterKey = "";
  renderSidebar();
}

function exportState() {
  const blob = new Blob(
    [JSON.stringify({ state: appState.state, exportedAt: new Date().toISOString() }, null, 2)],
    { type: "application/json" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "lic-investigator-state.json";
  a.click();
}

function importState(event) {
  /** @type {HTMLInputElement|null} */
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files ? input.files[0] : null;
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const raw = e.target && typeof e.target.result === "string" ? e.target.result : "";
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && data.state && typeof data.state === "object") {
        for (const [id, val] of Object.entries(data.state)) {
          const key = String(id);
          if (!appState.state[key] || !appState.state[key].resolved) {
            appState.state[key] = normalizeListingState(val);
          }
        }
        saveState();
        renderSidebar();
        if (appState.selectedId) selectListing(appState.selectedId);
        alert("State imported and merged successfully");
      }
    } catch {
      alert("Invalid file");
    }
  };
  reader.readAsText(file);
}

function loadListingsFile(event) {
  /** @type {HTMLInputElement|null} */
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files ? input.files[0] : null;
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const raw = e.target && typeof e.target.result === "string" ? e.target.result : "";
      setListings(JSON.parse(raw));
      if (appState.listingGraph) {
        applyGraphData(appState.listingGraph);
      }
      renderSidebar();
      if (appState.listings.length > 0) hideEmptyState();
      if (appState.selectedId && getListingById(appState.selectedId))
        selectListing(appState.selectedId);
    } catch {
      alert("Invalid listings.json");
    }
  };
  reader.readAsText(file);
}

function loadListingGraphFile(event) {
  /** @type {HTMLInputElement|null} */
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files ? input.files[0] : null;
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const raw = e.target && typeof e.target.result === "string" ? e.target.result : "";
      const graph = JSON.parse(raw);
      applyGraphData(graph);
      renderSidebar();
      if (appState.selectedId) selectListing(appState.selectedId);
    } catch {
      alert("Invalid listing-graph.json");
    }
  };
  reader.readAsText(file);
}

async function loadFromDisk() {
  try {
    const [listingsRes, graphRes] = await Promise.all([
      fetch("data/listings.json"),
      fetch("data/hash-graph/listing-graph.json"),
    ]);

    let loadedFromDisk = false;
    if (listingsRes.ok) {
      setListings(await listingsRes.json());
      hideEmptyState();
      loadedFromDisk = true;
    }

    if (graphRes.ok) {
      const graph = await graphRes.json();
      applyGraphData(graph);
      loadedFromDisk = true;
    } else if (listingsRes.ok) {
      applyGraphData(null);
    }

    if (loadedFromDisk) {
      renderSidebar();
      if (appState.selectedId) selectListing(appState.selectedId);
      return;
    }
  } catch {
    // fall through
  }

  try {
    const bootstrapRes = await fetch(buildApiUrl("/api/bootstrap"), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    if (bootstrapRes.ok) {
      const payload = await bootstrapRes.json();
      if (
        payload?.ok &&
        Array.isArray(payload.listings) &&
        payload.graph &&
        typeof payload.graph === "object"
      ) {
        setListings(payload.listings);
        applyGraphData(payload.graph);
        hideEmptyState();
        renderSidebar();
        if (appState.selectedId) selectListing(appState.selectedId);
        return;
      }
    }
  } catch {
    // no-op
  }

  console.log("Auto-load failed (local data and API bootstrap), use file picker instead");
  renderSidebar();
}

function applyAddressToCurrentComponent() {
  const key = String(appState.selectedId || "");
  if (!key) return;
  const sourceState = getListingState(key);
  const sourceAddress = sourceState.address.trim();
  if (!sourceState.resolved || !sourceAddress) {
    alert("Save a resolved address on the selected listing before bulk apply.");
    return;
  }

  const component = getCurrentComponent();
  if (!component || component.size <= 1) {
    alert("Selected listing does not have a multi-listing component.");
    return;
  }

  const conflictAddresses = getComponentConflictAddresses(component);
  if (conflictAddresses.length > 1) {
    alert(
      `Bulk apply blocked: component has conflicting resolved addresses (${conflictAddresses.join(" | ")}).`,
    );
    return;
  }

  const memberIds = component.listingIds
    .map((id) => String(id))
    .filter((id) => Boolean(getListingById(id)));
  const targetIds = memberIds.filter((id) => {
    const ls = getListingState(id);
    return !ls.resolved;
  });

  if (!targetIds.length) {
    alert(`No unresolved listings to update in Component C${component.componentId}.`);
    return;
  }

  const message = `Apply "${sourceAddress}" to ${targetIds.length} unresolved listing(s) in Component C${component.componentId}?`;
  if (!window.confirm(message)) return;

  const timestamp = nowIso();
  const changes = [];
  for (const id of targetIds) {
    const ls = getListingState(id);
    const prev = { ...ls };
    ls.address = sourceAddress;
    ls.resolved = true;
    ls.source = "inferred_component";
    ls.confidence = 0.8;
    ls.updatedAt = timestamp;
    changes.push({ id, prev });
  }

  if (!changes.length) return;
  appState.lastBulkApply = {
    componentId: String(component.componentId),
    sourceListingId: key,
    address: sourceAddress,
    createdAt: timestamp,
    changes,
  };

  saveState();
  selectListing(key);
}

function undoLastBulkApplyForCurrentComponent() {
  const key = String(appState.selectedId || "");
  if (!key || !appState.lastBulkApply) return;
  const component = getComponentForListing(key);
  if (!component || String(component.componentId) !== String(appState.lastBulkApply.componentId)) {
    alert("No bulk apply history for the current component.");
    return;
  }

  for (const change of appState.lastBulkApply.changes) {
    appState.state[String(change.id)] = normalizeListingState(change.prev);
  }
  appState.lastBulkApply = null;
  saveState();
  selectListing(key);
}

function handleClick(event) {
  const el = event.target.closest("[data-action]");
  if (!el) return;

  const action = el.dataset.action;

  if (action === "set-sidebar-mode") {
    setSidebarMode(el.dataset.mode);
    return;
  }

  if (action === "open-import") {
    document.getElementById("import-file").click();
    return;
  }

  if (action === "export-state") {
    exportState();
    return;
  }

  if (action === "reload-data") {
    loadFromDisk();
    return;
  }

  if (action === "select-listing") {
    selectListing(el.dataset.listingId);
    return;
  }

  if (action === "focus-cluster") {
    focusCluster(el.dataset.clusterKey);
    return;
  }

  if (action === "clear-cluster-focus") {
    clearClusterFocus();
    return;
  }

  if (action === "copy-url") {
    copyText(el.dataset.text || "");
    return;
  }

  if (action === "edit-address") {
    editAddress(el.dataset.listingId);
    return;
  }

  if (action === "geocode-address") {
    geocodeAndFill();
    return;
  }

  if (action === "save-address") {
    saveAddress(el.dataset.listingId);
    return;
  }

  if (action === "apply-component-address") {
    applyAddressToCurrentComponent();
    return;
  }

  if (action === "undo-component-apply") {
    undoLastBulkApplyForCurrentComponent();
  }
}

function handleInput(event) {
  if (event.target.id === "notes-input" && appState.selectedId) {
    saveNotes(appState.selectedId);
  }
}

function handleKeydown(event) {
  if (event.target.id === "address-input" && event.key === "Enter" && appState.selectedId) {
    saveAddress(appState.selectedId);
  }
}

function init() {
  loadState();

  const statusFilterEl = document.getElementById("filter-status");
  const bedsFilterEl = document.getElementById("filter-beds");
  const searchFilterEl = document.getElementById("filter-search");

  statusFilterEl.addEventListener("change", renderSidebar);
  bedsFilterEl.addEventListener("change", renderSidebar);
  searchFilterEl.addEventListener("input", renderSidebar);

  document.getElementById("import-file").addEventListener("change", importState);
  document.getElementById("load-listings-file").addEventListener("change", loadListingsFile);
  document.getElementById("load-graph-file").addEventListener("change", loadListingGraphFile);

  document.addEventListener("click", handleClick);
  document.addEventListener("input", handleInput);
  document.addEventListener("keydown", handleKeydown);

  updateViewModeButtons();
  renderSidebar();
  loadFromDisk();
}

init();
