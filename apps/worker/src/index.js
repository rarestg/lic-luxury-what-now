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

function decodeBase64UrlToBytes(input) {
  const binary = decodeBase64Url(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseJwtPart(part) {
  try {
    return JSON.parse(decodeBase64Url(part));
  } catch {
    return null;
  }
}

function normalizeTeamDomain(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "");
  return raw.replace(/\/+$/, "");
}

function isLocalDevRequest(request) {
  try {
    const url = new URL(request.url);
    const hostname = String(url.hostname || "")
      .trim()
      .toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function getUnverifiedIdentityFromToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  const payload = parseJwtPart(parts[1]);
  if (!payload || typeof payload !== "object") return null;
  return String(payload.email || payload.sub || "").trim() || null;
}

function audienceIncludes(audClaim, expectedAud) {
  if (Array.isArray(audClaim)) return audClaim.map((value) => String(value)).includes(expectedAud);
  if (audClaim == null) return false;
  return String(audClaim) === expectedAud;
}

const accessJwksCache = new Map(); // teamDomain -> { expiresAt, keys }
const ACCESS_JWKS_TTL_MS = 5 * 60 * 1000;
const JWT_CLOCK_SKEW_SECONDS = 60;
const textEncoder = new TextEncoder();

async function getAccessJwks(teamDomain, options = {}) {
  const forceRefresh = Boolean(options?.forceRefresh);
  const cacheKey = String(teamDomain);
  const now = Date.now();
  const cached = accessJwksCache.get(cacheKey);
  if (
    !forceRefresh &&
    cached &&
    cached.expiresAt > now &&
    Array.isArray(cached.keys) &&
    cached.keys.length
  ) {
    return cached.keys;
  }

  const res = await fetch(`https://${cacheKey}/cdn-cgi/access/certs`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Cloudflare Access cert fetch failed with HTTP ${res.status}`);

  const payload = await res.json();
  const rawKeys = Array.isArray(payload?.keys) ? payload.keys : [];
  const keys = rawKeys.filter(
    (key) =>
      key &&
      typeof key === "object" &&
      key.kty === "RSA" &&
      typeof key.n === "string" &&
      typeof key.e === "string",
  );
  if (!keys.length)
    throw new Error("Cloudflare Access cert payload did not include usable RSA JWKs");

  accessJwksCache.set(cacheKey, {
    expiresAt: now + ACCESS_JWKS_TTL_MS,
    keys,
  });
  return keys;
}

async function verifyAccessJwtAndExtractIdentity(token, teamDomain, expectedAud) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtPart(encodedHeader);
  const payload = parseJwtPart(encodedPayload);
  if (!header || !payload) return null;
  if (String(header.alg || "") !== "RS256") return null;

  const issuer = String(payload.iss || "").trim();
  const expectedIssuer = `https://${teamDomain}`;
  if (issuer !== expectedIssuer) return null;
  if (!audienceIncludes(payload.aud, expectedAud)) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  const nbf = Number(payload.nbf);
  if (!Number.isFinite(exp) || exp <= nowSeconds - JWT_CLOCK_SKEW_SECONDS) return null;
  if (Number.isFinite(nbf) && nbf > nowSeconds + JWT_CLOCK_SKEW_SECONDS) return null;

  const signingInput = textEncoder.encode(`${encodedHeader}.${encodedPayload}`);
  const signature = decodeBase64UrlToBytes(encodedSignature);
  let keys = await getAccessJwks(teamDomain);
  const kid = String(header.kid || "").trim();
  let candidateKeys = kid ? keys.filter((key) => String(key.kid || "") === kid) : keys;
  if (!candidateKeys.length && kid) {
    keys = await getAccessJwks(teamDomain, { forceRefresh: true });
    candidateKeys = keys.filter((key) => String(key.kid || "") === kid);
  }
  if (!candidateKeys.length) return null;

  let verified = false;
  for (const jwk of candidateKeys) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        signature,
        signingInput,
      );
      if (ok) {
        verified = true;
        break;
      }
    } catch {
      // try next candidate key
    }
  }
  if (!verified) return null;
  return String(payload.email || payload.sub || "").trim() || null;
}

async function getIdentityFromAccessJwt(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const expectedAud = String(env.CF_ACCESS_AUD || "").trim();
  const devBypassEnabled = isTruthy(env.ACCESS_DEV_BYPASS);
  const localDevRequest = isLocalDevRequest(request);

  if (devBypassEnabled && (localDevRequest || !teamDomain || !expectedAud)) {
    const devIdentity = String(request.headers.get("x-dev-user") || "").trim();
    return devIdentity || getUnverifiedIdentityFromToken(token) || "dev-bypass@local";
  }

  if (!token) return null;
  if (!teamDomain || !expectedAud) {
    console.error(
      JSON.stringify({
        event: "access_config_error",
        message:
          "Missing CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD. Set ACCESS_DEV_BYPASS=1 for local bypass mode.",
      }),
    );
    return null;
  }

  try {
    return await verifyAccessJwtAndExtractIdentity(token, teamDomain, expectedAud);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "access_verify_error",
        message: err?.message || "unknown access verification error",
      }),
    );
    return null;
  }
}

function sqlPlaceholders(count) {
  if (!Number.isFinite(count) || count <= 0) return "";
  return new Array(count).fill("?").join(", ");
}

function parseJsonObject(value, fallback = {}) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // no-op
  }
  return fallback;
}

function parseJsonArray(value, fallback = []) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // no-op
  }
  return fallback;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function maybeNumber(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asStringOrEmpty(value) {
  return isNonEmptyString(value) ? String(value).trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tableHasColumn(env, tableName, columnName) {
  const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows.some((row) => String(row.name || "") === columnName);
}

// --- Chunked IN-clause queries (D1 bind param safety) ---

const BIND_CHUNK_SIZE = 90;
const COMPONENT_LOCK_RETRY_ATTEMPTS = 20;
const COMPONENT_LOCK_RETRY_DELAY_MS = 100;
const COMPONENT_LOCK_TTL_MS = 15000;
let componentLockTableInitialized = false;

async function ensureComponentWriteLockTable(env) {
  if (componentLockTableInitialized) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS component_write_locks (
      lock_key TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ).run();
  componentLockTableInitialized = true;
}

function getComponentLockKey(componentId, listingId) {
  if (componentId == null) return `listing:${String(listingId)}`;
  return `component:${String(componentId)}`;
}

async function tryAcquireComponentWriteLock(env, lockKey, ownerToken) {
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + COMPONENT_LOCK_TTL_MS).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO component_write_locks (lock_key, owner_token, expires_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(lock_key) DO UPDATE SET
       owner_token = excluded.owner_token,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE component_write_locks.expires_at <= excluded.updated_at
        OR component_write_locks.owner_token = excluded.owner_token`,
  )
    .bind(lockKey, ownerToken, expiresAtIso, nowIso)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function releaseComponentWriteLock(env, lockKey, ownerToken) {
  await env.DB.prepare("DELETE FROM component_write_locks WHERE lock_key = ? AND owner_token = ?")
    .bind(lockKey, ownerToken)
    .run();
}

async function withComponentWriteLock(env, lockKey, fn) {
  await ensureComponentWriteLockTable(env);
  const ownerToken = crypto.randomUUID();

  for (let attempt = 1; attempt <= COMPONENT_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    const acquired = await tryAcquireComponentWriteLock(env, lockKey, ownerToken);
    if (!acquired) {
      if (attempt < COMPONENT_LOCK_RETRY_ATTEMPTS) await sleep(COMPONENT_LOCK_RETRY_DELAY_MS);
      continue;
    }

    try {
      return await fn();
    } finally {
      try {
        await releaseComponentWriteLock(env, lockKey, ownerToken);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "component_lock_release_error",
            lockKey,
            message: err?.message || "unknown lock release error",
          }),
        );
      }
    }
  }

  const err = Object.assign(new Error("Component write lock timeout"), {
    code: "COMPONENT_LOCK_TIMEOUT",
  });
  throw err;
}

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
      WITH ranked AS (
        SELECT
          listing_id,
          address,
          normalized_address,
          ROW_NUMBER() OVER (
            PARTITION BY listing_id
            ORDER BY asserted_at DESC, id DESC
          ) AS rn
        FROM address_assertions
        WHERE listing_id IN (${sqlPlaceholders(n)})
      )
      SELECT listing_id, address, normalized_address
      FROM ranked
      WHERE rn = 1
    `,
    listingIds,
  );
  const byListing = new Map();
  for (const row of rows) {
    const id = String(row.listing_id);
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

function buildRemovedIds(previousAssignments, nextAssignments) {
  const removed = [];
  for (const listingId of previousAssignments.keys()) {
    if (!nextAssignments.has(listingId)) removed.push(listingId);
  }
  return removed;
}

function buildChangedIds(previousAssignments, nextAssignments, removedIds = []) {
  const changed = new Set();
  for (const [listingId, nextValue] of nextAssignments.entries()) {
    const prev = previousAssignments.get(listingId);
    if (
      !prev ||
      prev.address !== nextValue.address ||
      prev.normalizedAddress !== nextValue.normalizedAddress ||
      prev.source !== nextValue.source ||
      Number(prev.confidence) !== Number(nextValue.confidence)
    ) {
      changed.add(listingId);
    }
  }
  for (const listingId of removedIds) {
    changed.add(listingId);
  }
  return [...changed].sort((a, b) => a.localeCompare(b));
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
  const identity = await getIdentityFromAccessJwt(request, env);
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
  const lockKey = getComponentLockKey(componentId, listingId);

  let propagationResult;
  try {
    propagationResult = await withComponentWriteLock(env, lockKey, async () => {
      const memberIds = await fetchComponentMemberIds(env, componentId, listingId);
      const previousAssignments = await fetchExistingAssignments(env, runId, memberIds);

      // Read existing assertions while holding component lock, then include the incoming assertion.
      const latestDirect = await fetchLatestAssertionsByListing(env, memberIds);
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
      const removedListingIds = buildRemovedIds(previousAssignments, nextAssignments);

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
      for (const id of removedListingIds) {
        statements.push(
          env.DB.prepare(
            "DELETE FROM listing_address_assignments WHERE run_id = ? AND listing_id = ?",
          ).bind(runId, id),
        );
      }
      await env.DB.batch(statements);

      const changedListingIds = buildChangedIds(
        previousAssignments,
        nextAssignments,
        removedListingIds,
      );
      const assignments = {};
      for (const listingIdKey of changedListingIds) {
        const row = nextAssignments.get(listingIdKey);
        if (row) {
          assignments[listingIdKey] = {
            address: row.address,
            resolved: true,
            source: row.source,
            confidence: row.confidence,
            updatedAt: now,
          };
        } else {
          assignments[listingIdKey] = {
            address: "",
            resolved: false,
            source: "",
            confidence: null,
            updatedAt: now,
          };
        }
      }

      return {
        conflict,
        changedListingIds,
        removedCount: removedListingIds.length,
        assignments,
      };
    });
  } catch (err) {
    if (err?.code === "COMPONENT_LOCK_TIMEOUT") {
      return json({ ok: false, error: "Component is busy. Please retry shortly." }, 409);
    }
    throw err;
  }

  console.log(
    JSON.stringify({
      event: "assertion",
      listingId,
      componentId,
      conflict: propagationResult.conflict,
      changedCount: propagationResult.changedListingIds.length,
      removedCount: propagationResult.removedCount,
      assertedBy: identity,
    }),
  );

  return json({
    ok: true,
    runId,
    componentId,
    conflict: propagationResult.conflict,
    changedListingIds: propagationResult.changedListingIds,
    assignments: propagationResult.assignments,
  });
}

async function handleBootstrap(env) {
  const [hasListingMetadata, hasEdgeSamplePairs] = await Promise.all([
    tableHasColumn(env, "listings", "metadata_json"),
    tableHasColumn(env, "listing_edges", "sample_image_pairs_json"),
  ]);

  const listingsRes = await env.DB.prepare(
    `SELECT id, title, source_url AS url, price, beds, baths, sqft, component_id${hasListingMetadata ? ", metadata_json" : ", NULL AS metadata_json"}
     FROM listings
     ORDER BY price DESC`,
  ).all();
  const edgeRes = await env.DB.prepare(
    `SELECT listing_a_id AS source, listing_b_id AS target, matched_image_pairs AS matchedImagePairs,
            min_phash_distance AS minPhashDistance, avg_phash_distance AS avgPhashDistance,
            min_dhash_distance AS minDhashDistance, avg_dhash_distance AS avgDhashDistance${hasEdgeSamplePairs ? ", sample_image_pairs_json" : ", NULL AS sample_image_pairs_json"}
     FROM listing_edges
     WHERE run_id = ?
     ORDER BY matched_image_pairs DESC`,
  )
    .bind(String(env.ACTIVE_RUN_ID || "active"))
    .all();

  const listingRows = Array.isArray(listingsRes.results) ? listingsRes.results : [];
  const listings = listingRows.map((row) => {
    const metadata = parseJsonObject(row.metadata_json, {});
    const listingId = String(row.id || "");

    const features = Array.isArray(metadata.features) ? metadata.features : [];
    const watchFlags = Array.isArray(metadata.watchFlags) ? metadata.watchFlags : [];
    const imageUrls = Array.isArray(metadata.imageUrls) ? metadata.imageUrls : [];

    return {
      id: listingId,
      webId: asStringOrEmpty(metadata.webId) || listingId,
      title: asStringOrEmpty(row.title) || asStringOrEmpty(metadata.title),
      url: asStringOrEmpty(row.url) || asStringOrEmpty(metadata.url),
      price: maybeNumber(row.price, maybeNumber(metadata.price)),
      beds: maybeNumber(row.beds, maybeNumber(metadata.beds)),
      baths: maybeNumber(row.baths, maybeNumber(metadata.baths)),
      sqft: maybeNumber(row.sqft, maybeNumber(metadata.sqft)),
      type: asStringOrEmpty(metadata.type),
      neighborhood: asStringOrEmpty(metadata.neighborhood),
      noFee: Boolean(metadata.noFee),
      features,
      description: isNonEmptyString(metadata.description) ? metadata.description : null,
      parking: isNonEmptyString(metadata.parking) ? metadata.parking : null,
      petPolicy: isNonEmptyString(metadata.petPolicy) ? metadata.petPolicy : null,
      watchFlags,
      imageUrls,
    };
  });
  const edges = Array.isArray(edgeRes.results)
    ? edgeRes.results.map((row) => ({
        ...row,
        sampleImagePairs: parseJsonArray(row.sample_image_pairs_json, []),
      }))
    : [];

  const componentMap = new Map();
  for (const row of listingRows) {
    const cid = row.component_id == null ? null : Number(row.component_id);
    if (cid == null) continue;
    if (!componentMap.has(cid)) componentMap.set(cid, []);
    componentMap.get(cid).push(String(row.id));
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
          isolatedListings: listingRows.filter((row) => row.component_id == null).length,
        },
      },
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

async function handleGeocode(request, env) {
  const identity = await getIdentityFromAccessJwt(request, env);
  if (!identity) return json({ ok: false, error: "Missing Access identity" }, 401);

  // Rate limit by verified identity
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
