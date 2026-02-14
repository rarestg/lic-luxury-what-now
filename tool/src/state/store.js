import { nowIso } from "../utils/format.js";

export const STORAGE_KEY = "lic-investigator-state";

export const appState = {
  listings: [],
  listingById: Object.create(null),
  listingGraph: null,
  graphAdjacency: Object.create(null),
  graphComponents: [],
  componentByListing: Object.create(null),
  componentColorById: Object.create(null),
  edgeLookup: Object.create(null),
  state: Object.create(null),
  selectedId: null,
  sidebarMode: "flat",
  focusedClusterKey: "",
  lastBulkApply: null,
};

export function normalizeListingState(value) {
  const raw = value && typeof value === "object" ? value : {};
  const address = typeof raw.address === "string" ? raw.address : "";
  const notes = typeof raw.notes === "string" ? raw.notes : "";
  const source = typeof raw.source === "string" ? raw.source : "";
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  const confidenceNum = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceNum) ? confidenceNum : null;
  const resolved = Boolean(raw.resolved && address.trim());
  return { address, notes, resolved, source, updatedAt, confidence };
}

export function setListings(nextListings) {
  appState.listings = Array.isArray(nextListings) ? nextListings : [];
  rebuildListingIndex();
}

export function rebuildListingIndex() {
  appState.listingById = Object.create(null);
  for (const listing of appState.listings) {
    const id = String(listing && listing.id != null ? listing.id : "");
    if (id) appState.listingById[id] = listing;
  }
}

export function getListingById(id) {
  return appState.listingById[String(id)] || null;
}

export function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === "object") {
        appState.state = Object.create(null);
        for (const [id, value] of Object.entries(parsed)) {
          appState.state[String(id)] = normalizeListingState(value);
        }
      }
    }
  } catch {
    appState.state = Object.create(null);
  }
}

export function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState.state));
}

export function getListingState(id) {
  const key = String(id);
  if (!Object.prototype.hasOwnProperty.call(appState.state, key)) {
    appState.state[key] = normalizeListingState(null);
  } else {
    appState.state[key] = normalizeListingState(appState.state[key]);
  }
  return appState.state[key];
}

export function mergeAssignments(assignments) {
  if (!assignments || typeof assignments !== "object") return;
  for (const [id, incomingRaw] of Object.entries(assignments)) {
    const key = String(id);
    const incoming = normalizeListingState(incomingRaw);
    const existing = getListingState(key);
    appState.state[key] = normalizeListingState({
      address: incoming.address,
      resolved: incoming.resolved,
      notes: existing.notes || "",
      source: incoming.source || existing.source || "",
      confidence: incoming.confidence != null ? incoming.confidence : existing.confidence,
      updatedAt: incoming.updatedAt || existing.updatedAt || nowIso(),
    });
  }
}
