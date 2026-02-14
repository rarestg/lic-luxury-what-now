import { isApiAssertionsEnabled, isGeocodeConfigured } from "../config/runtime-config.js";
import {
  getComponentConflictAddresses,
  getComponentForListing,
  getComponentResolutionSummary,
  getEdgeEvidence,
  getListingClusterColor,
  getSharedImageListings,
} from "../model/graph.js";
import { appState, getListingById, getListingState } from "../state/store.js";
import { escapeHtml, formatMetric, formatPrice, formatSqft, safeUrl } from "../utils/format.js";

function renderComponentPanel(component, selectedListingId) {
  if (!component || component.size <= 1) return "";

  const selectedIdStr = String(selectedListingId ?? "");
  const members = component.listingIds
    .map((id) => String(id))
    .filter((id) => Boolean(getListingById(id)))
    .map((id) => {
      const listing = getListingById(id);
      const ls = getListingState(id);
      return { id, listing, ls };
    });

  members.sort((a, b) => {
    if (a.ls.resolved !== b.ls.resolved) return a.ls.resolved ? 1 : -1;
    return Number(b.listing.price || 0) - Number(a.listing.price || 0);
  });

  const resolvedCount = members.filter((m) => m.ls.resolved).length;
  const unresolvedCount = members.length - resolvedCount;
  const memberRows = members
    .map((member) => {
      const active = member.id === selectedIdStr ? "active" : "";
      const stateClass = member.ls.resolved ? "resolved" : "";
      const statusLabel = member.ls.resolved ? "Resolved" : "Unresolved";
      return `<button type="button" class="member-chip ${stateClass} ${active}" data-action="select-listing" data-listing-id="${escapeHtml(member.id)}">#${escapeHtml(member.id)} ${escapeHtml(member.listing.title || "")} · ${statusLabel}</button>`;
    })
    .join("");

  return `<section class="section">
    <div class="section-header">
      <h3>Component Panel</h3>
      <span class="chip shared">${members.length} listings</span>
    </div>
    <div class="component-meta">
      <div class="component-stats">
        <span class="chip">Component C${escapeHtml(String(component.componentId))}</span>
        <span class="chip">Size ${members.length}</span>
        <span class="chip">Resolved ${resolvedCount}</span>
        <span class="chip">Unresolved ${unresolvedCount}</span>
      </div>
      <div class="component-actions">
        <button type="button" class="component-action-btn" data-action="focus-cluster" data-cluster-key="cluster:${escapeHtml(String(component.componentId))}">Focus Sidebar on Component</button>
      </div>
    </div>
    <div class="connected-members">${memberRows}</div>
  </section>`;
}

function renderConnectedMembers(sharedWith, evidence) {
  if (!sharedWith.size) return "";

  const evidenceByNeighbor = Object.create(null);
  for (const item of evidence) {
    evidenceByNeighbor[String(item.neighborId)] = item;
  }

  const rows = [...sharedWith]
    .map((id) => String(id ?? ""))
    .map((neighborId) => {
      const listing = getListingById(neighborId);
      const ls = getListingState(neighborId);
      const item = evidenceByNeighbor[neighborId] || {};
      const pairCount = Number.isFinite(item.matchedImagePairs) ? item.matchedImagePairs : 0;
      const minPhash = item.minPhashDistance == null ? "n/a" : item.minPhashDistance.toFixed(2);
      const avgPhash = item.avgPhashDistance == null ? "n/a" : item.avgPhashDistance.toFixed(2);
      const minDhash = item.minDhashDistance == null ? "n/a" : item.minDhashDistance.toFixed(2);
      const avgDhash = item.avgDhashDistance == null ? "n/a" : item.avgDhashDistance.toFixed(2);
      const strength = String(item.strength || "Weak");
      const strengthClass = strength.toLowerCase();
      const sampleRows = Array.isArray(item.sampleImagePairs)
        ? item.sampleImagePairs
            .slice(0, 3)
            .map((pair, idx) => {
              const urlA = safeUrl(pair?.urlA);
              const urlB = safeUrl(pair?.urlB);
              if (!urlA && !urlB) return "";
              return `<div class="sample-link-row">
          ${urlA ? `<a href="${escapeHtml(urlA)}" target="_blank" rel="noopener noreferrer">A${idx + 1}: ${escapeHtml(urlA)}</a>` : ""}
          ${urlB ? `<a href="${escapeHtml(urlB)}" target="_blank" rel="noopener noreferrer">B${idx + 1}: ${escapeHtml(urlB)}</a>` : ""}
        </div>`;
            })
            .filter(Boolean)
            .join("")
        : "";

      return `<article class="edge-card">
      <div class="edge-head">
        <button type="button" class="edge-link" data-action="select-listing" data-listing-id="${escapeHtml(neighborId)}">#${escapeHtml(neighborId)} ${escapeHtml(listing ? listing.title || "" : "")}</button>
        <div class="edge-meta">
          <span class="edge-strength ${escapeHtml(strengthClass)}">${escapeHtml(strength)}</span>
          <span>${pairCount} match pairs</span>
          <span>pHash min/avg ${escapeHtml(minPhash)} / ${escapeHtml(avgPhash)}</span>
          <span>dHash min/avg ${escapeHtml(minDhash)} / ${escapeHtml(avgDhash)}</span>
          <span>${ls.resolved ? "Resolved" : "Pending"}</span>
        </div>
      </div>
      <details>
        <summary>Sample image pairs</summary>
        <div class="sample-link-grid">
          ${sampleRows || '<div class="edge-empty">No sample image pairs available for this edge.</div>'}
        </div>
      </details>
    </article>`;
    });

  return `<div class="connected-evidence">${rows.join("")}</div>`;
}

function renderEdgeEvidenceSection(selectedListingId, evidence) {
  if (!evidence.length) return "";

  const MAX_EDGES = 8;
  const displayed = evidence.slice(0, MAX_EDGES);

  const cards = displayed
    .map((item) => {
      const neighborId = String(item.neighborId);
      const neighborListing = getListingById(neighborId);
      const pairCount = Number.isFinite(item.matchedImagePairs) ? item.matchedImagePairs : 0;
      const minPhash = item.minPhashDistance == null ? "n/a" : item.minPhashDistance.toFixed(2);
      const avgDistance = item.avgPhashDistance == null ? "n/a" : item.avgPhashDistance.toFixed(2);
      const minDhash = item.minDhashDistance == null ? "n/a" : item.minDhashDistance.toFixed(2);
      const avgDhash = item.avgDhashDistance == null ? "n/a" : item.avgDhashDistance.toFixed(2);
      const strength = String(item.strength || "Weak");
      const strengthClass = strength.toLowerCase();

      // `getEdgeEvidence()` normalizes this to an array, so `.map()` is safe here.
      const pairRows = item.sampleImagePairs
        .map((pair) => {
          const urlA = safeUrl(pair?.urlA);
          const urlB = safeUrl(pair?.urlB);
          if (!urlA && !urlB) return "";

          const imgA = urlA
            ? `<a class="pair-image" href="${escapeHtml(urlA)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(urlA)}" loading="lazy" alt="Matched sample A"></a>`
            : '<div class="pair-image"></div>';
          const imgB = urlB
            ? `<a class="pair-image" href="${escapeHtml(urlB)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(urlB)}" loading="lazy" alt="Matched sample B"></a>`
            : '<div class="pair-image"></div>';

          return `<div>
          <div class="pair-row">${imgA}${imgB}</div>
          <div class="pair-row-labels"><span>Listing #${escapeHtml(String(selectedListingId))}</span><span>Listing #${escapeHtml(neighborId)}</span></div>
        </div>`;
        })
        .filter(Boolean)
        .join("");

      return `<article class="edge-card">
      <div class="edge-head">
        <button type="button" class="edge-link" data-action="select-listing" data-listing-id="${escapeHtml(neighborId)}">#${escapeHtml(neighborId)} ${escapeHtml(neighborListing ? neighborListing.title || "" : "")}</button>
        <div class="edge-meta">
          <span class="edge-strength ${escapeHtml(strengthClass)}">${escapeHtml(strength)}</span>
          <span>${pairCount} match pairs</span>
          <span>pHash min/avg ${escapeHtml(minPhash)} / ${escapeHtml(avgDistance)}</span>
          <span>dHash min/avg ${escapeHtml(minDhash)} / ${escapeHtml(avgDhash)}</span>
        </div>
      </div>
      <div class="pair-grid">${pairRows || '<div class="edge-empty">No sample image pairs available for this edge.</div>'}</div>
    </article>`;
    })
    .join("");

  const truncated =
    evidence.length > MAX_EDGES
      ? `<p class="section-sub">Showing strongest ${MAX_EDGES} edges by matched image pairs (${evidence.length} total).</p>`
      : "";

  return `<section class="edge-section">
    <div class="section-header">
      <h3>Image-Match Evidence</h3>
      <span class="chip shared">${evidence.length} linked listings</span>
    </div>
    <p class="section-sub">Review side-by-side sample image pairs before propagating addresses across a cluster.</p>
    ${truncated}
    <div class="edge-grid">${cards}</div>
  </section>`;
}

function renderListingImages(imageUrls) {
  const cards = imageUrls
    .map((img, i) => {
      const safeImg = safeUrl(img);
      if (!safeImg) return "";

      const lensHref = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(safeImg)}`;

      return `<article class="image-card">
      <div class="image-frame">
        <a href="${escapeHtml(safeImg)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(safeImg)}" alt="Photo ${i + 1}" loading="lazy"></a>
        <div class="image-overlay">
          <a class="image-action primary" href="${lensHref}" target="_blank" rel="noopener noreferrer">Search Lens</a>
          <a class="image-action" href="${escapeHtml(safeImg)}" target="_blank" rel="noopener noreferrer">Open Full</a>
          <button class="image-action" type="button" data-action="copy-url" data-text="${escapeHtml(safeImg)}">Copy URL</button>
        </div>
      </div>
    </article>`;
    })
    .join("");

  return cards || '<div class="main-empty">No valid image URLs on this listing.</div>';
}

function renderDetailsPanels(listing, features) {
  const sections = [];

  if (features.length) {
    sections.push(`<details class="collapsible" open>
      <summary>Features (${features.length})</summary>
      <div class="collapsible-content"><div class="features-grid">${features.map((f) => `<span class="feature">${escapeHtml(f)}</span>`).join("")}</div></div>
    </details>`);
  }

  if (listing.description) {
    sections.push(`<details class="collapsible" open>
      <summary>Description</summary>
      <div class="collapsible-content"><div class="description">${escapeHtml(listing.description)}</div></div>
    </details>`);
  }

  if (listing.parking) {
    sections.push(`<details class="collapsible">
      <summary>Parking</summary>
      <div class="collapsible-content">${escapeHtml(listing.parking)}</div>
    </details>`);
  }

  if (listing.petPolicy) {
    sections.push(`<details class="collapsible">
      <summary>Pet Policy</summary>
      <div class="collapsible-content">${escapeHtml(listing.petPolicy)}</div>
    </details>`);
  }

  return sections.join("");
}

export function renderListingDetails(selectedId) {
  appState.selectedId = String(selectedId);
  const listing = getListingById(appState.selectedId);
  if (!listing) return "";

  const ls = getListingState(appState.selectedId);
  const component = getComponentForListing(appState.selectedId);
  const componentSummary = getComponentResolutionSummary(component);
  const sharedWith = getSharedImageListings(appState.selectedId);
  const sharedWithCount = sharedWith.size;
  const evidence = getEdgeEvidence(appState.selectedId);

  const watchFlags = Array.isArray(listing.watchFlags) ? listing.watchFlags : [];
  const features = Array.isArray(listing.features) ? listing.features : [];
  const imageUrls = Array.isArray(listing.imageUrls) ? listing.imageUrls : [];

  const listingUrl =
    safeUrl(listing.url) ||
    `https://www.luxuryapartmentslic.com/index.cfm?page=properties&id=${encodeURIComponent(appState.selectedId)}`;

  const priceDisplay = formatPrice(listing.price);
  const bedsDisplay = formatMetric(listing.beds);
  const bathsDisplay = formatMetric(listing.baths);
  const sqftDisplay = formatSqft(listing.sqft, false);

  const clusterColor = getListingClusterColor(appState.selectedId);
  const clustered = Boolean(component && component.size > 1);
  const geocodeEnabled = isGeocodeConfigured();
  const geocodeConfigHint = geocodeEnabled
    ? ""
    : '<p class="address-help">Geocode is disabled. Configure <code>.env</code> and run <code>node scripts/generate-tool-config.cjs</code>. For Cloudflare, prefer <code>LIC_GEOCODE_ENDPOINT</code>.</p>';
  const addressSummary =
    componentSummary.addresses.length === 1
      ? componentSummary.addresses[0]
      : componentSummary.addresses.length > 1
        ? `${componentSummary.addresses.length} addresses in this cluster`
        : "No resolved addresses in this cluster yet";

  const conflictAddresses = getComponentConflictAddresses(component);
  const hasComponentConflict = conflictAddresses.length > 1;
  const lastBulkIsCurrent = Boolean(
    appState.lastBulkApply &&
      component &&
      String(appState.lastBulkApply.componentId) === String(component.componentId),
  );
  const metadataBits = [];
  if (ls.source) metadataBits.push(`source: ${ls.source}`);
  if (ls.confidence != null) metadataBits.push(`confidence: ${ls.confidence}`);
  if (ls.updatedAt) metadataBits.push(`updated: ${ls.updatedAt}`);
  const metadataLine = metadataBits.length
    ? `<p class="section-sub">${escapeHtml(metadataBits.join(" · "))}</p>`
    : "";
  const apiMode = isApiAssertionsEnabled();
  const saveModeLine = apiMode
    ? '<p class="section-sub">Save mode: API-backed (`POST /api/assertions`) with local cache merge.</p>'
    : '<p class="section-sub">Save mode: local-only (`localStorage`).</p>';
  const showLocalBulkActions = Boolean(clustered && !apiMode);
  const apiPropagationHint =
    clustered && apiMode
      ? '<p class="address-cluster-hint">API mode: bulk apply is disabled. Save an address on one listing and let server propagation update the component.</p>'
      : "";

  return `
    <div class="detail-shell">
      <section class="hero">
        <div>
          <div class="hero-title">
            <h2>${escapeHtml(listing.title || "Unknown")}</h2>
            <span class="hero-id">#${escapeHtml(appState.selectedId)}</span>
          </div>

          <div class="hero-price">$${priceDisplay}</div>

          <div class="hero-metrics">
            <span class="metric-chip">${bedsDisplay} BR</span>
            <span class="metric-chip">${bathsDisplay} BA</span>
            <span class="metric-chip">${sqftDisplay === "N/A" ? "Sq Ft N/A" : `${sqftDisplay} ft²`}</span>
            <span class="metric-chip">${escapeHtml(listing.neighborhood || "Area N/A")}</span>
            <span class="metric-chip">${escapeHtml(listing.type || "Type N/A")}${listing.noFee ? " / No Fee" : ""}</span>
            <span class="metric-chip">${sharedWithCount} linked listings</span>
          </div>

          ${watchFlags.length ? `<div class="watch-flags">${watchFlags.map((f) => `<span class="chip warn">${escapeHtml(f)}</span>`).join("")}</div>` : ""}
        </div>

        <div class="hero-side">
          <a class="hero-link" href="${escapeHtml(listingUrl)}" target="_blank" rel="noopener noreferrer">View Listing Source</a>
          <div class="hero-cluster">
            <div style="display:flex;align-items:center;gap:8px; justify-content:flex-end;"><span class="cluster-color-dot" style="background:${escapeHtml(clusterColor)}"></span><strong>${clustered ? `Cluster C${escapeHtml(String(component.componentId))}` : "Unclustered listing"}</strong></div>
            <div>${clustered ? `${componentSummary.resolvedCount}/${component.size} resolved` : "No cluster neighbors in graph"}</div>
            <div>${escapeHtml(addressSummary)}</div>
          </div>
        </div>
      </section>

      <section class="address-section">
        <div class="section-header">
          <h3>Address Resolution</h3>
          <span class="address-status ${ls.resolved ? "resolved" : "pending"}">${ls.resolved ? "Resolved" : "Pending"}</span>
        </div>

        <p class="address-help">Normalize with geocode, then save. Bulk apply is a separate action and defaults to unresolved listings only.</p>
        ${saveModeLine}
        ${metadataLine}

        ${
          ls.resolved
            ? `<div class="address-resolved-box">
              <strong>${escapeHtml(ls.address)}</strong>
              <button type="button" class="address-btn edit" data-action="edit-address" data-listing-id="${escapeHtml(appState.selectedId)}">Edit Address</button>
            </div>`
            : `<div class="address-row">
              <input type="text" id="address-input" placeholder="Paste resolved address here..." value="${escapeHtml(ls.address || "")}">
              <div class="address-buttons">
                <button type="button" class="address-btn geocode" id="geocode-btn" data-action="geocode-address" ${geocodeEnabled ? "" : 'disabled title="Configure geocoding in .env and regenerate config.local.js"'}>Normalize</button>
                <button type="button" class="address-btn save" data-action="save-address" data-listing-id="${escapeHtml(appState.selectedId)}">Save Address</button>
              </div>
            </div>${geocodeConfigHint}`
        }

        ${clustered ? `<p class="address-cluster-hint">Cluster C${escapeHtml(String(component.componentId))}: ${componentSummary.resolvedCount} resolved, ${component.size - componentSummary.resolvedCount} unresolved.</p>` : ""}
        ${apiPropagationHint}
        ${clustered && hasComponentConflict ? `<div class="component-warning">Component has conflicting resolved addresses (${escapeHtml(conflictAddresses.join(" | "))}). Inference is blocked until conflict is resolved.</div>` : ""}
        ${
          showLocalBulkActions
            ? `<div class="component-actions" style="margin-bottom:10px;">
          <button type="button" class="component-action-btn" data-action="apply-component-address">Apply Address To Component</button>
          <button type="button" class="component-action-btn warn" data-action="undo-component-apply" ${lastBulkIsCurrent ? "" : "disabled"}>Undo Last Bulk Apply</button>
        </div>`
            : ""
        }

        <textarea class="notes-input" id="notes-input" placeholder="Notes (optional)...">${escapeHtml(ls.notes || "")}</textarea>
      </section>

      <section class="image-section">
        <div class="section-header">
          <h3>Primary Investigation Images</h3>
          <span class="chip shared">${imageUrls.length} image${imageUrls.length === 1 ? "" : "s"}</span>
        </div>
        <p class="section-sub">Use larger action targets directly on each image: Google Lens, open full-size, or copy URL.</p>
        <div class="image-gallery">${renderListingImages(imageUrls)}</div>
      </section>

      ${
        clustered || sharedWithCount > 0
          ? `<section class="section">
        <div class="section-header">
          <h3>Connected Listings</h3>
          <span class="chip shared">${sharedWithCount} direct neighbors</span>
        </div>
        <p class="section-sub">Each neighbor includes edge evidence and strength from listing-graph.json.</p>
        ${renderConnectedMembers(sharedWith, evidence)}
      </section>`
          : ""
      }

      ${renderComponentPanel(component, appState.selectedId)}

      ${renderEdgeEvidenceSection(appState.selectedId, evidence)}

      ${renderDetailsPanels(listing, features)}
    </div>
  `;
}
