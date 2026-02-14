# Top 3 Graph Workflow Priorities

This guide defines the three highest-value improvements for the current graph-driven investigation flow.

## Implementation Status (2026-02-13)

Local UI (`tool/index.html`) now includes:

1. Component-level UX: component metadata, member navigation panel, current-component filters
2. Edge evidence visibility in connected listings: match counts, min/avg pHash+dHash, sample URL pairs, strength label
3. Local-first bulk resolve: apply selected address to unresolved component members, conflict block, single-step undo

Cloud-backed propagation remains out of scope for this doc and is tracked in `docs/cloudflare-deployment.md`.

Scope:

1. Component-level UX
2. Edge evidence visibility
3. Bulk resolve action in UI

Out of scope for now:

1. Hashing algorithm scalability (`O(n^2)` matcher optimizations)
2. Additional graph-generation changes

## Why These 3 First

Current state:

1. The repo already has a usable perceptual graph (`data/hash-graph/listing-graph.json`)
2. UI now uses graph adjacency for “connected listings”
3. Address propagation exists offline in `scripts/build-image-graph.py` but not in interactive UI

Main bottleneck is no longer data generation. It is operator throughput and trust in cluster-level decisions.

## 1) Component-Level UX

## Context

`listing-graph.json` contains component structure:

1. `components[].componentId`
2. `components[].size`
3. `components[].listingIds`

UI currently shows only per-listing neighbor count, not component membership as a first-class concept.

## Why this is an issue

1. Operators cannot reason about a cluster as a unit
2. No way to answer “how many unresolved listings remain in this cluster?”
3. No fast navigation across a component without manual searching
4. Hard to do consistent, batch-style resolution work

## Right way to solve it

Promote components to first-class UI objects:

1. Build component index on load:
2. `listingId -> componentId`
3. `componentId -> {listingIds, size}`

Add component-aware UI affordances:

1. Detail header badges:
2. `Component #<id>`
3. `Size: <n>`
4. `Resolved: <x>/<n>`

2. Component panel:
3. All listings in component
4. Sort by resolved status then price
5. One-click navigation between members

3. Component filters:
4. `Current Component`
5. `Unresolved In Component`
6. `Resolved In Component`

## Acceptance criteria

1. Selecting a listing immediately shows its component metadata
2. User can navigate all component listings without global search
3. User can see unresolved workload per component at a glance

## 2) Edge Evidence Visibility

## Context

Graph edges already contain useful confidence context:

1. `matchedImagePairs`
2. `minPhashDistance`, `avgPhashDistance`
3. `minDhashDistance`, `avgDhashDistance`
4. `sampleImagePairs[]` with example matched URLs

UI currently shows connected listing IDs but not why the edge exists.

## Why this is an issue

1. Connections are opaque, so users cannot quickly validate quality
2. Hard to distinguish strong links from weak/suspicious links
3. Increases risk of propagating incorrect addresses
4. Reduces trust in graph results

## Right way to solve it

Expose edge-level evidence where decisions happen:

1. Build edge lookup map on load:
2. Key format: sorted pair `min(idA,idB)|max(idA,idB)`
3. Value: edge payload from `listing-graph.json`

2. In “connected listings” section, show per-neighbor evidence:
3. `matchedImagePairs`
4. `min/avg` hash distances

3. Add expandable evidence drawer:
4. Show up to 3 `sampleImagePairs`
5. Render thumbnails or direct links for `urlA`/`urlB`
6. Keep “open in new tab” actions for quick visual verification

4. Add simple strength label:
5. `Strong`, `Medium`, `Weak` based on configurable rules

## Suggested initial strength rules

1. Strong: `matchedImagePairs >= 5` and `avgPhashDistance <= 2`
2. Medium: `matchedImagePairs >= 2` and `avgPhashDistance <= 5`
3. Weak: everything else

## Acceptance criteria

1. For every connected listing row, user can inspect edge strength and sample evidence
2. User can decide propagation using visible support, not just adjacency

## 3) Bulk Resolve Action (UI)

## Context

Bulk propagation is currently available only as offline CLI:

1. `scripts/build-image-graph.py --seed-addresses ...`

Target workflow is interactive:

1. Resolve one listing via Lens
2. Propagate to related listings immediately

## Why this is an issue

1. Current workflow requires export + script run + reload cycle
2. High friction interrupts manual investigation
3. Prevents near-real-time team collaboration
4. Increases chance of stale/local divergence

## Right way to solve it

Implement local-first bulk resolve now, API-backed later with same semantics.

Local-first phase:

1. Add button in detail panel:
2. `Apply Address To Component`

2. Open preview modal before write:
3. Address to apply
4. Target set size
5. How many already resolved
6. Potential conflicts detected (if multiple resolved addresses already exist)

3. On confirm:
4. Set unresolved component members to same address
5. Mark source metadata per listing:
6. `source: direct | inferred_component`
7. `confidence`
8. `updatedAt`

4. Provide undo operation:
5. `Revert last bulk apply` for that component

Cloud-backed phase:

1. Keep same button behavior
2. Replace local mutation with API call:
3. `POST /api/assertions`
4. Merge returned assignments into local state

## Guardrails (important)

1. Never silently overwrite direct user-resolved addresses
2. If component has conflicting resolved addresses, block bulk apply and require explicit user choice
3. Allow “apply only to unresolved” as default mode

## Acceptance criteria

1. User can resolve one listing and apply to component in under 2 clicks after save
2. No direct manual resolution is overwritten without explicit confirmation
3. Bulk action is reversible

## Recommended Delivery Order

1. Component-Level UX
2. Edge Evidence Visibility
3. Bulk Resolve Action

Reason:

1. Bulk resolve should come after users can inspect component context and edge quality
2. This reduces false propagation and cleanup work

## Minimal Technical Design

Client-side derived structures to add:

1. `componentByListingId: Record<string, number>`
2. `componentsById: Record<number, { listingIds: string[], size: number }>`
3. `edgeByPair: Record<string, Edge>`

State extensions:

1. `state[listingId].source`
2. `state[listingId].confidence`
3. `state[listingId].updatedAt`
4. `state[listingId].history[]` (optional for undo)

## What “Done” Looks Like

1. Operators can work component-by-component, not listing-by-listing
2. Every edge can be inspected with concrete evidence
3. One verified address can be propagated safely and quickly
4. Later Cloudflare API adoption becomes a transport swap, not a workflow redesign
