import { isSharedListing } from "../model/graph.js";
import { appState, getListingState } from "../state/store.js";

export function updateStats() {
  const totalListings = appState.listings.length;
  const resolved = appState.listings.filter((l) => getListingState(l.id).resolved).length;
  const pending = totalListings - resolved;
  const sharedCount = appState.listings.filter((l) => isSharedListing(l.id)).length;

  const totalClusters = appState.graphComponents.length;
  let resolvedClusters = 0;
  if (totalClusters) {
    resolvedClusters = appState.graphComponents.filter((component) =>
      component.listingIds.some((id) => getListingState(id).resolved),
    ).length;
  }

  document.getElementById("stat-resolved").textContent = `${resolved} resolved`;
  document.getElementById("stat-pending").textContent = `${pending} pending`;
  document.getElementById("stat-shared").textContent = `${sharedCount} connected listings`;
  document.getElementById("stat-clusters").textContent = totalClusters
    ? `${resolvedClusters}/${totalClusters} clusters resolved`
    : "No graph clusters";
  document.getElementById("stat-total").textContent = `${totalListings} listings`;

  const width = totalListings ? (resolved / totalListings) * 100 : 0;
  document.getElementById("progress-fill").style.width = `${width}%`;
}
