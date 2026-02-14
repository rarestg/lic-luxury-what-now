import { appState, getListingState } from "../state/store.js";
import { hashToHue } from "../utils/format.js";

export function getEdgeKey(a, b) {
  const aa = String(a ?? "");
  const bb = String(b ?? "");
  if (!aa || !bb) return "";
  return aa < bb ? `${aa}__${bb}` : `${bb}__${aa}`;
}

export function getClusterColorByComponentId(componentId) {
  const key = String(componentId ?? "");
  if (!key) return "hsl(208 30% 45%)";
  if (!appState.componentColorById[key]) {
    appState.componentColorById[key] = `hsl(${hashToHue(key)} 68% 54%)`;
  }
  return appState.componentColorById[key];
}

function buildGraphAdjacency(graph) {
  const adjacency = Object.create(null);
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.edges)) return adjacency;
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== "object") continue;
    const a = String(edge.source ?? "");
    const b = String(edge.target ?? "");
    if (!a || !b || a === b) continue;
    if (!adjacency[a]) adjacency[a] = new Set();
    if (!adjacency[b]) adjacency[b] = new Set();
    adjacency[a].add(b);
    adjacency[b].add(a);
  }
  return adjacency;
}

function buildEdgeLookup(graph) {
  const lookup = Object.create(null);
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.edges)) return lookup;
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== "object") continue;
    const a = String(edge.source ?? "");
    const b = String(edge.target ?? "");
    const key = getEdgeKey(a, b);
    if (!key) continue;
    const current = lookup[key];
    const currentScore = Number(current?.matchedImagePairs);
    const nextScore = Number(edge.matchedImagePairs);
    if (
      !current ||
      (Number.isFinite(nextScore) && (!Number.isFinite(currentScore) || nextScore > currentScore))
    ) {
      lookup[key] = edge;
    }
  }
  return lookup;
}

function computeComponentsFromAdjacency() {
  const components = [];
  const visited = new Set();
  const allIds = new Set(appState.listings.map((l) => String(l.id)));
  for (const key of Object.keys(appState.graphAdjacency)) allIds.add(String(key));

  let seq = 1;
  for (const rawId of allIds) {
    const id = String(rawId ?? "");
    if (!id || visited.has(id)) continue;
    const queue = [id];
    visited.add(id);
    const memberIds = [];
    let queueIdx = 0;

    while (queueIdx < queue.length) {
      const current = queue[queueIdx++];
      memberIds.push(current);
      const neighbors = appState.graphAdjacency[current] || new Set();
      for (const n of neighbors) {
        const nn = String(n ?? "");
        if (!nn || visited.has(nn)) continue;
        visited.add(nn);
        queue.push(nn);
      }
    }

    components.push({
      componentId: String(seq++),
      listingIds: memberIds,
      size: memberIds.length,
      edgeCount: 0,
    });
  }

  components.sort((a, b) => b.size - a.size);
  return components;
}

function normalizeGraphComponents(graph) {
  const normalized = [];
  if (graph && typeof graph === "object" && Array.isArray(graph.components)) {
    for (let i = 0; i < graph.components.length; i += 1) {
      const raw = graph.components[i];
      if (!raw || typeof raw !== "object") continue;
      const listingIds = Array.isArray(raw.listingIds)
        ? [...new Set(raw.listingIds.map((id) => String(id ?? "")).filter(Boolean))]
        : [];
      if (!listingIds.length) continue;
      const componentId = String(raw.componentId ?? i + 1);
      const edgeCount = Number(raw.edgeCount);
      normalized.push({
        componentId,
        listingIds,
        size: listingIds.length,
        edgeCount: Number.isFinite(edgeCount) ? edgeCount : 0,
      });
    }
  }

  if (
    !normalized.length &&
    graph &&
    typeof graph === "object" &&
    (Object.keys(appState.graphAdjacency).length || Array.isArray(graph.edges))
  ) {
    return computeComponentsFromAdjacency();
  }

  normalized.sort((a, b) => b.size - a.size || a.componentId.localeCompare(b.componentId));
  return normalized;
}

function rebuildComponentIndex() {
  appState.componentByListing = Object.create(null);
  appState.componentColorById = Object.create(null);
  for (const component of appState.graphComponents) {
    const compId = String(component.componentId ?? "");
    if (!compId) continue;
    const color = getClusterColorByComponentId(compId);
    appState.componentColorById[compId] = color;
    for (const id of component.listingIds) {
      appState.componentByListing[String(id)] = component;
    }
  }
}

export function applyGraphData(graph) {
  appState.listingGraph = graph;
  appState.graphAdjacency = buildGraphAdjacency(graph);
  appState.edgeLookup = buildEdgeLookup(graph);
  appState.graphComponents = normalizeGraphComponents(graph);
  rebuildComponentIndex();

  if (appState.focusedClusterKey) {
    const exists =
      appState.graphComponents.some(
        (c) => `cluster:${c.componentId}` === appState.focusedClusterKey,
      ) || appState.focusedClusterKey === "unclustered";
    if (!exists) appState.focusedClusterKey = "";
  }
}

export function getSharedImageListings(listingId) {
  const key = String(listingId);
  return new Set(appState.graphAdjacency[key] || []);
}

export function getSharedImageCount(listingId) {
  return getSharedImageListings(listingId).size;
}

export function isSharedListing(listingId) {
  return getSharedImageCount(listingId) > 0;
}

export function getComponentForListing(listingId) {
  return appState.componentByListing[String(listingId)] || null;
}

export function getListingClusterColor(listingId) {
  const component = getComponentForListing(listingId);
  if (!component || component.size <= 1) return "hsl(208 23% 38%)";
  return getClusterColorByComponentId(component.componentId);
}

export function getComponentResolutionSummary(component) {
  if (!component) return { resolvedCount: 0, addresses: [] };
  let resolvedCount = 0;
  const addressSet = new Set();
  for (const id of component.listingIds) {
    const ls = getListingState(id);
    if (ls.resolved) {
      resolvedCount += 1;
      if (ls.address.trim()) addressSet.add(ls.address.trim());
    }
  }
  return {
    resolvedCount,
    addresses: [...addressSet],
  };
}

export function getCurrentComponent() {
  if (!appState.selectedId) return null;
  return getComponentForListing(appState.selectedId);
}

export function getCurrentComponentIdSet() {
  const component = getCurrentComponent();
  if (!component) return null;
  return new Set(component.listingIds.map((id) => String(id)));
}

export function edgeStrength(edge) {
  const pairCount = Number(edge?.matchedImagePairs);
  const avgPhash = Number(edge?.avgPhashDistance);
  if (pairCount >= 5 && Number.isFinite(avgPhash) && avgPhash <= 2) return "Strong";
  if (pairCount >= 2 && Number.isFinite(avgPhash) && avgPhash <= 5) return "Medium";
  return "Weak";
}

export function getEdgeEvidence(listingId) {
  const fromId = String(listingId);
  const neighbors = [...getSharedImageListings(fromId)];

  const evidence = neighbors.map((neighborId) => {
    const toId = String(neighborId);
    const edge = appState.edgeLookup[getEdgeKey(fromId, toId)] || null;
    const score = Number(edge?.matchedImagePairs);
    const avgDist = Number(edge?.avgPhashDistance);
    const samples = edge && Array.isArray(edge.sampleImagePairs) ? edge.sampleImagePairs : [];

    return {
      neighborId: toId,
      edge,
      matchedImagePairs: Number.isFinite(score) ? score : 0,
      avgPhashDistance: Number.isFinite(avgDist) ? avgDist : null,
      minPhashDistance: Number.isFinite(Number(edge?.minPhashDistance))
        ? Number(edge.minPhashDistance)
        : null,
      avgDhashDistance: Number.isFinite(Number(edge?.avgDhashDistance))
        ? Number(edge.avgDhashDistance)
        : null,
      minDhashDistance: Number.isFinite(Number(edge?.minDhashDistance))
        ? Number(edge.minDhashDistance)
        : null,
      sampleImagePairs: samples,
      strength: edgeStrength(edge),
    };
  });

  evidence.sort(
    (a, b) => b.matchedImagePairs - a.matchedImagePairs || a.neighborId.localeCompare(b.neighborId),
  );
  return evidence;
}

export function getComponentConflictAddresses(component) {
  if (!component) return [];
  const canonical = new Map();
  for (const id of component.listingIds) {
    const ls = getListingState(id);
    if (!ls.resolved || !ls.address.trim()) continue;
    const raw = ls.address.trim();
    const norm = raw.toLowerCase();
    if (!canonical.has(norm)) canonical.set(norm, raw);
  }
  return [...canonical.values()];
}
