// --- Helpers ---

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function normalizeAddress(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function decodeBase64Url(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return atob(padded);
}

function getIdentityFromAccessJwt(request) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return String(payload.email || payload.sub || "").trim() || null;
  } catch (err) {
    return null;
  }
}

function sqlPlaceholders(count) {
  if (!Number.isFinite(count) || count <= 0) return "";
  return new Array(count).fill("?").join(", ");
}

// --- Chunked IN-clause queries (D1 bind param safety) ---

const BIND_CHUNK_SIZE = 90;

async function queryInChunks(env, buildSql, ids, extraBindPrefix = []) {
  if (!ids.length) return [];
  const allRows = [];
  for (let i = 0; i < ids.length; i += BIND_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + BIND_CHUNK_SIZE);
    const sql = buildSql(chunk.length);
    const result = await env.DB.prepare(sql)
      .bind(...extraBindPrefix, ...chunk)
      .all();
    const rows = Array.isArray(result.results) ? result.results : [];
    allRows.push(...rows);
  }
  return allRows;
}

// --- DB helpers ---

async function ensureRun(env, runId) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO runs (id, created_at, phash_threshold, dhash_threshold, notes) VALUES (?, ?, 0, 0, ?)",
  )
    .bind(runId, now, "Active run placeholder for live assertions")
    .run();
}

async function fetchListing(env, listingId) {
  const row = await env.DB.prepare("SELECT id, component_id FROM listings WHERE id = ?")
    .bind(listingId)
    .first();
  return row || null;
}

async function fetchComponentMemberIds(env, componentId, listingId) {
  if (componentId == null) return [String(listingId)];
  const result = await env.DB.prepare("SELECT id FROM listings WHERE component_id = ? ORDER BY id")
    .bind(componentId)
    .all();
  const rows = Array.isArray(result.results) ? result.results : [];
  if (!rows.length) return [String(listingId)];
  return rows.map((row) => String(row.id));
}

async function fetchLatestAssertionsByListing(env, listingIds) {
  if (!listingIds.length) return new Map();
  const rows = await queryInChunks(
    env,
    (n) => `
      SELECT listing_id, address, normalized_address, asserted_at, id
      FROM address_assertions
      WHERE listing_id IN (${sqlPlaceholders(n)})
      ORDER BY asserted_at DESC, id DESC
    `,
    listingIds,
  );
  const byListing = new Map();
  // Sort all results by asserted_at DESC, id DESC to get correct "latest" across chunks
  rows.sort((a, b) => {
    if (a.asserted_at !== b.asserted_at) return a.asserted_at > b.asserted_at ? -1 : 1;
    return a.id > b.id ? -1 : 1;
  });
  for (const row of rows) {
    const id = String(row.listing_id);
    if (byListing.has(id)) continue;
    byListing.set(id, {
      listingId: id,
      address: String(row.address || ""),
      normalizedAddress: String(row.normalized_address || ""),
    });
  }
  return byListing;
}

async function fetchExistingAssignments(env, runId, listingIds) {
  if (!listingIds.length) return new Map();
  const rows = await queryInChunks(
    env,
    (n) => `
      SELECT listing_id, address, normalized_address, source, confidence
      FROM listing_address_assignments
      WHERE run_id = ? AND listing_id IN (${sqlPlaceholders(n)})
    `,
    listingIds,
    [runId],
  );
  const byListing = new Map();
  for (const row of rows) {
    byListing.set(String(row.listing_id), {
      address: String(row.address || ""),
      normalizedAddress: String(row.normalized_address || ""),
      source: String(row.source || ""),
      confidence: Number(row.confidence),
    });
  }
  return byListing;
}

function buildChangedIds(previousAssignments, nextAssignments) {
  const changed = [];
  for (const [listingId, nextValue] of nextAssignments.entries()) {
    const prev = previousAssignments.get(listingId);
    if (
      !prev ||
      prev.address !== nextValue.address ||
      prev.normalizedAddress !== nextValue.normalizedAddress ||
      prev.source !== nextValue.source ||
      Number(prev.confidence) !== Number(nextValue.confidence)
    ) {
      changed.push(listingId);
    }
  }
  return changed;
}

// --- Geocode rate limiter (in-memory, per-isolate) ---

const geocodeRateMap = new Map(); // identity -> { count, windowStart }
const GEOCODE_RATE_LIMIT = 30; // requests per window
const GEOCODE_RATE_WINDOW = 60000; // 1 minute in ms

function checkGeoRate(identity) {
  const now = Date.now();
  let entry = geocodeRateMap.get(identity);
  if (!entry || now - entry.windowStart > GEOCODE_RATE_WINDOW) {
    entry = { count: 0, windowStart: now };
    geocodeRateMap.set(identity, entry);
  }
  entry.count++;
  return entry.count <= GEOCODE_RATE_LIMIT;
}

// --- Route handlers ---

async function handlePostAssertions(request, env) {
  const identity = getIdentityFromAccessJwt(request);
  if (!identity) return json({ ok: false, error: "Missing Access identity" }, 401);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const listingId = String(body && body.listingId != null ? body.listingId : "").trim();
  const address = String(body && body.address != null ? body.address : "").trim();
  const source = String(body?.source ? body.source : "manual_ui").trim() || "manual_ui";
  if (!listingId) return json({ ok: false, error: "listingId is required" }, 400);
  if (!address) return json({ ok: false, error: "address is required" }, 400);

  const normalizedAddress = normalizeAddress(address);
  const now = new Date().toISOString();
  const runId = String(env.ACTIVE_RUN_ID || "active");

  await ensureRun(env, runId);

  const listing = await fetchListing(env, listingId);
  if (!listing) return json({ ok: false, error: `listingId not found: ${listingId}` }, 404);

  const componentId = listing.component_id == null ? null : Number(listing.component_id);
  const memberIds = await fetchComponentMemberIds(env, componentId, listingId);
  const previousAssignments = await fetchExistingAssignments(env, runId, memberIds);

  // Read existing assertions BEFORE writing, then include the new assertion in-memory
  const latestDirect = await fetchLatestAssertionsByListing(env, memberIds);
  // Override with the new assertion for this listing (it's the newest)
  latestDirect.set(String(listingId), {
    listingId: String(listingId),
    address,
    normalizedAddress,
  });

  const directAddressSet = new Set();
  for (const entry of latestDirect.values()) {
    if (entry.normalizedAddress) directAddressSet.add(entry.normalizedAddress);
  }
  const conflict = directAddressSet.size > 1;

  const nextAssignments = new Map();
  if (conflict) {
    for (const [id, direct] of latestDirect.entries()) {
      nextAssignments.set(id, {
        address: direct.address,
        normalizedAddress: direct.normalizedAddress,
        source: "direct",
        confidence: 1.0,
      });
    }
  } else {
    for (const id of memberIds) {
      const direct = latestDirect.get(id);
      if (direct) {
        nextAssignments.set(id, {
          address: direct.address,
          normalizedAddress: direct.normalizedAddress,
          source: "direct",
          confidence: 1.0,
        });
      } else {
        nextAssignments.set(id, {
          address,
          normalizedAddress,
          source: "inferred_component",
          confidence: 0.8,
        });
      }
    }
  }

  // Atomic batch: assertion insert + all assignment upserts in one DB.batch()
  const statements = [
    env.DB.prepare(
      "INSERT INTO address_assertions (listing_id, address, normalized_address, source, confidence, asserted_at, asserted_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(listingId, address, normalizedAddress, source, 1.0, now, identity),
  ];
  for (const [id, row] of nextAssignments.entries()) {
    statements.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO listing_address_assignments (run_id, listing_id, address, normalized_address, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(runId, id, row.address, row.normalizedAddress, row.source, row.confidence),
    );
  }
  await env.DB.batch(statements);

  const changedListingIds = buildChangedIds(previousAssignments, nextAssignments);
  const assignments = {};
  for (const listingIdKey of changedListingIds) {
    const row = nextAssignments.get(listingIdKey);
    assignments[listingIdKey] = {
      address: row.address,
      resolved: true,
      source: row.source,
      confidence: row.confidence,
      updatedAt: now,
    };
  }

  console.log(
    JSON.stringify({
      event: "assertion",
      listingId,
      componentId,
      conflict,
      changedCount: changedListingIds.length,
      assertedBy: identity,
    }),
  );

  return json({
    ok: true,
    runId,
    componentId,
    conflict,
    changedListingIds,
    assignments,
  });
}

async function handleBootstrap(env) {
  const listingsRes = await env.DB.prepare(
    `SELECT id, title, source_url AS url, price, beds, baths, sqft, component_id
     FROM listings
     ORDER BY price DESC`,
  ).all();
  const edgeRes = await env.DB.prepare(
    `SELECT listing_a_id AS source, listing_b_id AS target, matched_image_pairs AS matchedImagePairs,
            min_phash_distance AS minPhashDistance, avg_phash_distance AS avgPhashDistance,
            min_dhash_distance AS minDhashDistance, avg_dhash_distance AS avgDhashDistance
     FROM listing_edges
     WHERE run_id = ?
     ORDER BY matched_image_pairs DESC`,
  )
    .bind(String(env.ACTIVE_RUN_ID || "active"))
    .all();

  const listings = Array.isArray(listingsRes.results) ? listingsRes.results : [];
  const edges = Array.isArray(edgeRes.results)
    ? edgeRes.results.map((row) => ({
        ...row,
        sampleImagePairs: [],
      }))
    : [];

  const componentMap = new Map();
  for (const listing of listings) {
    const cid = listing.component_id == null ? null : Number(listing.component_id);
    if (cid == null) continue;
    if (!componentMap.has(cid)) componentMap.set(cid, []);
    componentMap.get(cid).push(String(listing.id));
  }
  const components = [...componentMap.entries()].map(([componentId, listingIds]) => ({
    componentId: String(componentId),
    listingIds,
    size: listingIds.length,
  }));

  return json(
    {
      ok: true,
      listings,
      graph: {
        generatedAt: new Date().toISOString(),
        nodes: listings.map((row) => ({
          id: String(row.id),
          title: row.title || "",
          url: row.url || "",
        })),
        edges,
        components,
        totals: {
          nodes: listings.length,
          edges: edges.length,
          components: components.length,
          isolatedListings: listings.filter((row) => row.component_id == null).length,
        },
      },
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

async function handleGeocode(request, env) {
  // Rate limit by identity (Access already gates the app)
  const identity = getIdentityFromAccessJwt(request) || "anonymous";
  if (!checkGeoRate(identity)) {
    return json({ ok: false, error: "Rate limit exceeded. Try again shortly." }, 429);
  }

  const googleApiKey = String(env.GOOGLE_MAPS_API_KEY || "").trim();
  if (!googleApiKey) {
    return json({ ok: false, error: "GOOGLE_MAPS_API_KEY is not configured" }, 501);
  }

  const url = new URL(request.url);
  const rawAddress = String(url.searchParams.get("address") || "").trim();
  if (!rawAddress) return json({ ok: false, error: "address query param is required" }, 400);

  const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(rawAddress)}&key=${encodeURIComponent(googleApiKey)}`;

  const upstream = await fetch(geocodeUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });
  if (!upstream.ok) {
    return json({ ok: false, error: `Google geocode HTTP ${upstream.status}` }, 502);
  }

  const payload = await upstream.json();
  if (payload.status === "OK" && Array.isArray(payload.results) && payload.results.length > 0) {
    return json({
      ok: true,
      address: String(payload.results[0].formatted_address || "").trim(),
    });
  }
  return json(
    { ok: false, error: "No geocode result found", status: payload.status || "UNKNOWN" },
    404,
  );
}

// --- Router with top-level error handling ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, now: new Date().toISOString() });
    }

    try {
      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        return await handleBootstrap(env);
      }

      if (url.pathname === "/api/geocode" && request.method === "GET") {
        return await handleGeocode(request, env);
      }

      if (url.pathname === "/api/assertions" && request.method === "POST") {
        return await handlePostAssertions(request, env);
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "error",
          path: url.pathname,
          method: request.method,
          message: err.message,
          stack: err.stack,
        }),
      );
      return json({ ok: false, error: "Internal server error" }, 500);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};
