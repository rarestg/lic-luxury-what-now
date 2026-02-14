import {
  getClusterColorByComponentId,
  getComponentForListing,
  getComponentResolutionSummary,
  getCurrentComponentIdSet,
  getListingClusterColor,
  getSharedImageCount,
  isSharedListing,
} from "../model/graph.js";
import { appState, getListingState } from "../state/store.js";
import { escapeHtml, formatMetric, formatPrice, formatSqft } from "../utils/format.js";
import { updateStats } from "./stats.js";

export function getStatusFilterValue() {
  const el = document.getElementById("filter-status");
  if (!(el instanceof HTMLSelectElement)) return "all";
  return el ? el.value : "all";
}

export function getBedsFilterValue() {
  const el = document.getElementById("filter-beds");
  if (!(el instanceof HTMLSelectElement)) return "all";
  return el ? el.value : "all";
}

export function getSearchFilterValue() {
  const el = document.getElementById("filter-search");
  if (!(el instanceof HTMLInputElement)) return "";
  return el ? el.value.toLowerCase() : "";
}

function listingMatchesFilters(listing, statusFilter, bedsFilter, searchFilter) {
  const ls = getListingState(listing.id);
  const id = String(listing.id ?? "");
  const currentComponentIds = getCurrentComponentIdSet();

  if (statusFilter === "pending" && ls.resolved) return false;
  if (statusFilter === "resolved" && !ls.resolved) return false;
  if (statusFilter === "shared-images" && !isSharedListing(listing.id)) return false;
  if (statusFilter === "current-component") {
    if (!currentComponentIds || !currentComponentIds.has(id)) return false;
  }
  if (statusFilter === "unresolved-current-component") {
    if (!currentComponentIds || !currentComponentIds.has(id) || ls.resolved) return false;
  }
  if (statusFilter === "resolved-current-component") {
    if (!currentComponentIds || !currentComponentIds.has(id) || !ls.resolved) return false;
  }
  if (bedsFilter !== "all" && Number(listing.beds) < Number.parseInt(bedsFilter, 10)) return false;

  if (searchFilter) {
    const haystack = [
      listing.title,
      listing.neighborhood,
      ls.address,
      ls.notes,
      listing.id,
      listing.description || "",
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(searchFilter)) return false;
  }

  return true;
}

function renderListingCard(listing) {
  const id = String(listing.id ?? "");
  const ls = getListingState(id);
  const sharedCount = getSharedImageCount(id);
  const clusterColor = getListingClusterColor(id);
  const component = getComponentForListing(id);
  const isClustered = Boolean(component && component.size > 1);

  const watchFlags = Array.isArray(listing.watchFlags) ? listing.watchFlags : [];
  const priceDisplay = formatPrice(listing.price);
  const bedsDisplay = formatMetric(listing.beds);
  const bathsDisplay = formatMetric(listing.baths);
  const sqftDisplay = formatSqft(listing.sqft, true);

  const classes = ["listing-card"];
  if (String(appState.selectedId ?? "") === id) classes.push("active");

  return `<div class="${classes.join(" ")}" style="--cluster-color:${escapeHtml(clusterColor)}" data-action="select-listing" data-listing-id="${escapeHtml(id)}">
    <div class="card-head">
      <span class="status-pill ${ls.resolved ? "resolved" : "pending"}">${ls.resolved ? "Resolved" : "Pending"}</span>
      <span class="cluster-pill"><span class="cluster-color-dot" style="background:${escapeHtml(clusterColor)}"></span>${isClustered ? `C${escapeHtml(String(component.componentId))}` : "Unclustered"}</span>
    </div>

    <div class="card-price-row">
      <div class="price">$${priceDisplay}</div>
      <div class="card-layout">${bedsDisplay} BR · ${bathsDisplay} BA</div>
    </div>

    <div class="title">${escapeHtml(listing.title || "Unknown")}</div>
    <div class="card-meta">${escapeHtml(listing.neighborhood || "N/A")} · #${escapeHtml(id)}${sqftDisplay ? ` · ${escapeHtml(sqftDisplay)}` : ""}</div>

    <div class="card-address ${ls.resolved ? "resolved" : "pending"}">${ls.resolved ? escapeHtml(ls.address) : "Address not resolved yet"}</div>

    <div class="card-tags">
      ${sharedCount > 0 ? `<span class="chip shared">${sharedCount} linked</span>` : '<span class="chip">No links</span>'}
      ${listing.noFee ? '<span class="chip">No Fee</span>' : ""}
      ${watchFlags.length ? `<span class="chip warn">${watchFlags.length} watch flag${watchFlags.length === 1 ? "" : "s"}</span>` : ""}
      ${ls.notes.trim() ? '<span class="chip note">Has notes</span>' : ""}
    </div>
  </div>`;
}

function buildClusterGroups(filteredListings) {
  const groupsByKey = new Map();

  for (const listing of filteredListings) {
    const id = String(listing.id ?? "");
    const component = getComponentForListing(id);
    const clustered = Boolean(component && component.size > 1);
    const key = clustered ? `cluster:${component.componentId}` : "unclustered";

    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        key,
        component: clustered ? component : null,
        members: [],
        unclustered: !clustered,
      });
    }
    groupsByKey.get(key).members.push(listing);
  }

  const groups = [...groupsByKey.values()];

  for (const group of groups) {
    group.members.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
  }

  groups.sort((a, b) => {
    if (a.unclustered && !b.unclustered) return 1;
    if (!a.unclustered && b.unclustered) return -1;
    if (a.unclustered && b.unclustered) return b.members.length - a.members.length;
    const as = a.component ? a.component.size : a.members.length;
    const bs = b.component ? b.component.size : b.members.length;
    return bs - as;
  });

  return groups;
}

function renderClusterOverview(groups) {
  const clustered = groups.filter((g) => !g.unclustered);
  if (!clustered.length) return "";

  return `<div class="cluster-overview">
    <h3>Cluster Navigator</h3>
    <div class="cluster-jumps">
      ${clustered
        .map((group) => {
          const comp = group.component;
          const summary = getComponentResolutionSummary(comp);
          const color = getClusterColorByComponentId(comp.componentId);
          const active = appState.focusedClusterKey === group.key ? "active" : "";
          return `<button type="button" class="cluster-jump ${active}" data-action="focus-cluster" data-cluster-key="${escapeHtml(group.key)}">
          <span class="cluster-color-dot" style="background:${escapeHtml(color)}"></span>
          C${escapeHtml(String(comp.componentId))} · ${group.members.length} · ${summary.resolvedCount} resolved
        </button>`;
        })
        .join("")}
      ${
        groups.some((g) => g.unclustered)
          ? `<button type="button" class="cluster-jump ${appState.focusedClusterKey === "unclustered" ? "active" : ""}" data-action="focus-cluster" data-cluster-key="unclustered">Unclustered · ${groups.find((g) => g.unclustered).members.length}</button>`
          : ""
      }
    </div>
  </div>`;
}

function renderClusterGroup(group) {
  const cards = group.members.map(renderListingCard).join("");

  if (group.unclustered) {
    return `<div class="cluster-group">
      <div class="cluster-header">
        <button type="button" data-action="focus-cluster" data-cluster-key="${escapeHtml(group.key)}">
          <div class="cluster-header-main">
            <span>Unclustered Listings</span>
            <span class="cluster-unresolved-tag">${group.members.length} listing${group.members.length === 1 ? "" : "s"}</span>
          </div>
          <div class="cluster-header-sub">
            <span>Listings without perceptual-image links to other listings.</span>
          </div>
        </button>
      </div>
      <div class="cluster-members">${cards}</div>
    </div>`;
  }

  const component = group.component;
  const summary = getComponentResolutionSummary(component);
  const total = component.size;
  const allResolved = summary.resolvedCount === total;
  const addressSummary =
    summary.addresses.length === 1
      ? summary.addresses[0]
      : summary.addresses.length > 1
        ? `${summary.addresses.length} distinct addresses in cluster`
        : "No resolved address yet";

  const color = getClusterColorByComponentId(component.componentId);

  return `<div class="cluster-group">
    <div class="cluster-header">
      <button type="button" data-action="focus-cluster" data-cluster-key="${escapeHtml(group.key)}">
        <div class="cluster-header-main">
          <span style="display:inline-flex; gap:8px; align-items:center;"><span class="cluster-color-dot" style="background:${escapeHtml(color)}"></span>Cluster C${escapeHtml(String(component.componentId))}</span>
          <span class="${allResolved ? "cluster-resolved-tag" : "cluster-unresolved-tag"}">${summary.resolvedCount}/${total} resolved</span>
        </div>
        <div class="cluster-header-sub">
          <span>${group.members.length} shown · ${total} total</span>
          <span>${escapeHtml(addressSummary)}</span>
        </div>
      </button>
    </div>
    <div class="cluster-members">${cards}</div>
  </div>`;
}

export function updateViewModeButtons() {
  const flatBtn = document.getElementById("view-flat");
  const clusteredBtn = document.getElementById("view-clustered");
  if (!flatBtn || !clusteredBtn) return;

  flatBtn.classList.toggle("active", appState.sidebarMode === "flat");
  clusteredBtn.classList.toggle("active", appState.sidebarMode === "clustered");
}

export function renderSidebar() {
  const sidebar = document.getElementById("sidebar");
  updateViewModeButtons();

  if (!appState.listings.length) {
    sidebar.innerHTML = '<div class="sidebar-empty">No listings loaded yet.</div>';
    updateStats();
    return;
  }

  const statusFilter = getStatusFilterValue();
  const bedsFilter = getBedsFilterValue();
  const searchFilter = getSearchFilterValue();

  const filtered = appState.listings.filter((listing) =>
    listingMatchesFilters(listing, statusFilter, bedsFilter, searchFilter),
  );

  if (!filtered.length) {
    sidebar.innerHTML = '<div class="sidebar-empty">No listings match current filters.</div>';
    updateStats();
    return;
  }

  if (appState.sidebarMode === "clustered") {
    const groups = buildClusterGroups(filtered);
    const focusBanner = appState.focusedClusterKey
      ? `<div class="cluster-focus">Focused: ${escapeHtml(appState.focusedClusterKey === "unclustered" ? "Unclustered" : appState.focusedClusterKey.replace("cluster:", "Cluster C"))}<button type="button" data-action="clear-cluster-focus">Clear focus</button></div>`
      : "";

    const visibleGroups = appState.focusedClusterKey
      ? groups.filter((group) => group.key === appState.focusedClusterKey)
      : groups;

    sidebar.innerHTML = `${renderClusterOverview(groups)}${focusBanner}${visibleGroups.map(renderClusterGroup).join("") || '<div class="sidebar-empty">No listings in selected cluster.</div>'}`;
  } else {
    filtered.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
    sidebar.innerHTML = `<div class="sidebar-stack">${filtered.map(renderListingCard).join("")}</div>`;
  }

  updateStats();
}
