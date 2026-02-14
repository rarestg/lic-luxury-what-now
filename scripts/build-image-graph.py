#!/usr/bin/env python3
"""
Build a perceptual-image graph for LIC listings.

Pipeline:
1) Read listings + image map
2) Download unique images in parallel (cached on disk)
3) Compute image perceptual hashes (cached by file metadata)
4) Find near-duplicate images via Hamming distance thresholds
5) Aggregate image matches into listing-to-listing graph edges
6) Optionally propagate known addresses across connected components

Outputs (under data/hash-graph by default):
- image-hashes.json
- image-similarity.json
- listing-graph.json
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

try:
    from PIL import Image, ImageOps
    import imagehash
except Exception as exc:  # pragma: no cover
    print(
        "Missing dependencies. Install with:\n"
        "  pip3 install imagehash pillow\n"
        f"Import error: {exc}",
        file=sys.stderr,
    )
    sys.exit(1)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    tmp.replace(path)


def normalize_address(address: str) -> str:
    return " ".join(address.strip().split()).lower()


def decode_seed_mapping(payload: Any, source_name: str) -> Dict[str, str]:
    """
    Accepts:
    - { "state": { listingId: {address, resolved} } }  (tool export format)
    - { listingId: "address" }
    - { listingId: {address, resolved?} }
    - [ {listingId/id, address, resolved?}, ... ]
    """
    out: Dict[str, str] = {}

    if isinstance(payload, dict) and isinstance(payload.get("state"), dict):
        state = payload["state"]
        for listing_id, value in state.items():
            if not isinstance(value, dict):
                continue
            address = str(value.get("address", "")).strip()
            resolved = bool(value.get("resolved"))
            if address and resolved:
                out[str(listing_id)] = address
        return out

    if isinstance(payload, dict):
        for listing_id, value in payload.items():
            if isinstance(value, str):
                address = value.strip()
                if address:
                    out[str(listing_id)] = address
                continue
            if isinstance(value, dict):
                address = str(value.get("address", "")).strip()
                resolved = bool(value.get("resolved", True))
                if address and resolved:
                    out[str(listing_id)] = address
        return out

    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, dict):
                continue
            listing_id = item.get("listingId", item.get("id"))
            if listing_id is None:
                continue
            address = str(item.get("address", "")).strip()
            resolved = bool(item.get("resolved", True))
            if address and resolved:
                out[str(listing_id)] = address
        return out

    print(f"Warning: unsupported seed-address format in {source_name}", file=sys.stderr)
    return out


def load_seed_addresses(paths: Iterable[Path]) -> Tuple[Dict[str, str], List[Dict[str, Any]]]:
    merged: Dict[str, str] = {}
    sources: List[Dict[str, Any]] = []

    for p in paths:
        payload = load_json(p)
        decoded = decode_seed_mapping(payload, str(p))
        for k, v in decoded.items():
            merged[k] = v
        sources.append({"path": str(p), "entries": len(decoded)})

    return merged, sources


def safe_image_extension(url: str, content_type: str = "") -> str:
    parsed = urllib.parse.urlparse(url)
    ext = Path(parsed.path).suffix.lower()
    valid = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
    if ext in valid:
        return ext
    ctype = content_type.lower()
    if "jpeg" in ctype:
        return ".jpg"
    if "png" in ctype:
        return ".png"
    if "webp" in ctype:
        return ".webp"
    return ".img"


def url_digest(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()


def relpath_for_url(url: str) -> str:
    digest = url_digest(url)
    parsed = urllib.parse.urlparse(url)
    ext = Path(parsed.path).suffix.lower()
    if not ext:
        ext = ".jpg"
    return f"{digest[:2]}/{digest[2:]}{ext}"


def listing_image_index(listings: List[Dict[str, Any]]) -> Dict[str, Set[str]]:
    url_to_listing_ids: Dict[str, Set[str]] = defaultdict(set)
    for listing in listings:
        listing_id = str(listing.get("id", "")).strip()
        if not listing_id:
            continue
        image_urls = listing.get("imageUrls") or []
        if not isinstance(image_urls, list):
            continue
        for url in image_urls:
            if isinstance(url, str) and url.startswith("http"):
                url_to_listing_ids[url].add(listing_id)
    return url_to_listing_ids


def image_map_index(image_map_payload: Dict[str, Any]) -> Dict[str, Set[str]]:
    url_to_listing_ids: Dict[str, Set[str]] = defaultdict(set)
    for url, listing_ids in image_map_payload.items():
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        if not isinstance(listing_ids, list):
            continue
        for listing_id in listing_ids:
            lid = str(listing_id).strip()
            if lid:
                url_to_listing_ids[url].add(lid)
    return url_to_listing_ids


def download_one(
    url: str,
    downloads_dir: Path,
    timeout_sec: int,
    retries: int,
    user_agent: str,
) -> Dict[str, Any]:
    rel_path = relpath_for_url(url)
    dst = downloads_dir / rel_path
    dst.parent.mkdir(parents=True, exist_ok=True)

    if dst.exists() and dst.stat().st_size > 0:
        st = dst.stat()
        return {
            "url": url,
            "relPath": rel_path,
            "status": "cached",
            "bytes": st.st_size,
            "contentType": "",
            "httpStatus": 200,
            "error": None,
            "mtimeNs": st.st_mtime_ns,
        }

    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    last_error: Optional[str] = None

    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                data = resp.read()
                code = getattr(resp, "status", None) or resp.getcode()
                ctype = str(resp.headers.get("Content-Type", ""))
                if not data:
                    raise ValueError("empty body")

                ext = safe_image_extension(url, ctype)
                if not rel_path.endswith(ext):
                    rel_path = f"{url_digest(url)[:2]}/{url_digest(url)[2:]}{ext}"
                    dst = downloads_dir / rel_path
                    dst.parent.mkdir(parents=True, exist_ok=True)

                tmp = dst.with_suffix(dst.suffix + ".tmp")
                with tmp.open("wb") as f:
                    f.write(data)
                tmp.replace(dst)
                st = dst.stat()
                return {
                    "url": url,
                    "relPath": rel_path,
                    "status": "downloaded",
                    "bytes": len(data),
                    "contentType": ctype,
                    "httpStatus": int(code),
                    "error": None,
                    "mtimeNs": st.st_mtime_ns,
                }
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)

        # Basic backoff
        if attempt < retries:
            time.sleep(min(2.0, 0.25 * (2 ** (attempt - 1))))

    return {
        "url": url,
        "relPath": rel_path,
        "status": "error",
        "bytes": 0,
        "contentType": "",
        "httpStatus": None,
        "error": last_error or "unknown error",
        "mtimeNs": None,
    }


def build_download_manifest(
    urls: List[str],
    downloads_dir: Path,
    workers: int,
    timeout_sec: int,
    retries: int,
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    total = len(urls)
    done = 0
    started = time.time()
    ua = "Mozilla/5.0 (compatible; lic-listings-bot/1.0)"

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [
            ex.submit(download_one, url, downloads_dir, timeout_sec, retries, ua)
            for url in urls
        ]
        for fut in concurrent.futures.as_completed(futs):
            done += 1
            record = fut.result()
            out.append(record)
            if done % 100 == 0 or done == total:
                elapsed = time.time() - started
                rate = done / elapsed if elapsed > 0 else 0.0
                print(
                    f"[download] {done}/{total} ({rate:.1f}/s) "
                    f"errors={sum(1 for r in out if r['status'] == 'error')}"
                )
    out.sort(key=lambda r: r["url"])
    return out


def load_existing_hash_cache(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        payload = load_json(path)
        images = payload.get("images", [])
        if not isinstance(images, list):
            return {}
        by_url: Dict[str, Dict[str, Any]] = {}
        for row in images:
            if isinstance(row, dict) and isinstance(row.get("url"), str):
                by_url[row["url"]] = row
        return by_url
    except Exception:  # noqa: BLE001
        return {}


def compute_hashes(
    records: List[Dict[str, Any]],
    downloads_dir: Path,
    phash_size: int,
    dhash_size: int,
    existing_cache: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    total = len(records)
    done = 0

    for rec in records:
        done += 1
        row = dict(rec)
        row.setdefault("phash", None)
        row.setdefault("dhash", None)
        row.setdefault("hashStatus", None)
        row.setdefault("hashError", None)

        if rec["status"] == "error":
            row["hashStatus"] = "skipped_download_error"
            out.append(row)
            continue

        file_path = downloads_dir / rec["relPath"]
        if not file_path.exists() or file_path.stat().st_size <= 0:
            row["hashStatus"] = "missing_file"
            row["hashError"] = "download file not found"
            out.append(row)
            continue

        st = file_path.stat()
        cache_hit = existing_cache.get(rec["url"])
        if (
            cache_hit
            and cache_hit.get("hashStatus") == "ok"
            and cache_hit.get("bytes") == st.st_size
            and cache_hit.get("mtimeNs") == st.st_mtime_ns
            and cache_hit.get("phash")
            and cache_hit.get("dhash")
        ):
            row["phash"] = cache_hit.get("phash")
            row["dhash"] = cache_hit.get("dhash")
            row["hashStatus"] = "cached"
            out.append(row)
            if done % 250 == 0 or done == total:
                print(f"[hash] {done}/{total}")
            continue

        try:
            with Image.open(file_path) as img:
                img = ImageOps.exif_transpose(img).convert("RGB")
                ph = imagehash.phash(img, hash_size=phash_size)
                dh = imagehash.dhash(img, hash_size=dhash_size)
            row["phash"] = str(ph)
            row["dhash"] = str(dh)
            row["hashStatus"] = "ok"
            row["bytes"] = st.st_size
            row["mtimeNs"] = st.st_mtime_ns
        except Exception as exc:  # noqa: BLE001
            row["hashStatus"] = "error"
            row["hashError"] = str(exc)

        out.append(row)
        if done % 250 == 0 or done == total:
            print(f"[hash] {done}/{total}")

    return out


def int_from_hex(h: str) -> int:
    return int(h, 16)


def build_similarity_and_graph(
    hashed_rows: List[Dict[str, Any]],
    listings: List[Dict[str, Any]],
    image_to_listing_ids: Dict[str, Set[str]],
    phash_threshold: int,
    dhash_threshold: int,
    min_edge_support: int,
    max_image_matches_output: int,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    valid_rows = []
    for r in hashed_rows:
        if r.get("hashStatus") not in {"ok", "cached"}:
            continue
        if not r.get("phash") or not r.get("dhash"):
            continue
        listing_ids = sorted(image_to_listing_ids.get(r["url"], set()))
        if not listing_ids:
            continue
        valid_rows.append(
            {
                "url": r["url"],
                "relPath": r["relPath"],
                "phash": r["phash"],
                "dhash": r["dhash"],
                "phashInt": int_from_hex(r["phash"]),
                "dhashInt": int_from_hex(r["dhash"]),
                "listingIds": listing_ids,
            }
        )

    n = len(valid_rows)
    print(f"[match] comparing {n} hashed images")
    comparisons = n * (n - 1) // 2

    image_matches_output: List[Dict[str, Any]] = []
    total_image_matches = 0
    listing_edge_tmp: Dict[str, Dict[str, Any]] = {}

    start = time.time()
    for i in range(n):
        a = valid_rows[i]
        for j in range(i + 1, n):
            b = valid_rows[j]

            # Skip if all listing IDs are identical and no cross-listing signal.
            if set(a["listingIds"]) == set(b["listingIds"]):
                continue

            pd = (a["phashInt"] ^ b["phashInt"]).bit_count()
            if pd > phash_threshold:
                continue

            dd = (a["dhashInt"] ^ b["dhashInt"]).bit_count()
            if dd > dhash_threshold:
                continue

            total_image_matches += 1
            if len(image_matches_output) < max_image_matches_output:
                image_matches_output.append(
                    {
                        "urlA": a["url"],
                        "urlB": b["url"],
                        "phashDistance": pd,
                        "dhashDistance": dd,
                        "listingIdsA": a["listingIds"],
                        "listingIdsB": b["listingIds"],
                    }
                )

            for la in a["listingIds"]:
                for lb in b["listingIds"]:
                    if la == lb:
                        continue
                    x, y = (la, lb) if la < lb else (lb, la)
                    key = f"{x}|{y}"
                    e = listing_edge_tmp.get(key)
                    if not e:
                        e = {
                            "source": x,
                            "target": y,
                            "matchedImagePairs": 0,
                            "sumPhashDistance": 0,
                            "sumDhashDistance": 0,
                            "minPhashDistance": math.inf,
                            "minDhashDistance": math.inf,
                            "sampleImagePairs": [],
                        }
                        listing_edge_tmp[key] = e

                    e["matchedImagePairs"] += 1
                    e["sumPhashDistance"] += pd
                    e["sumDhashDistance"] += dd
                    e["minPhashDistance"] = min(e["minPhashDistance"], pd)
                    e["minDhashDistance"] = min(e["minDhashDistance"], dd)
                    if len(e["sampleImagePairs"]) < 3:
                        e["sampleImagePairs"].append(
                            {
                                "urlA": a["url"],
                                "urlB": b["url"],
                                "phashDistance": pd,
                                "dhashDistance": dd,
                            }
                        )

        if (i + 1) % 300 == 0 or (i + 1) == n:
            elapsed = time.time() - start
            print(
                f"[match] {i + 1}/{n} rows, "
                f"matches={total_image_matches}, elapsed={elapsed:.1f}s"
            )

    listing_edges: List[Dict[str, Any]] = []
    for e in listing_edge_tmp.values():
        if e["matchedImagePairs"] < min_edge_support:
            continue
        listing_edges.append(
            {
                "source": e["source"],
                "target": e["target"],
                "matchedImagePairs": e["matchedImagePairs"],
                "avgPhashDistance": round(e["sumPhashDistance"] / e["matchedImagePairs"], 3),
                "avgDhashDistance": round(e["sumDhashDistance"] / e["matchedImagePairs"], 3),
                "minPhashDistance": int(e["minPhashDistance"]),
                "minDhashDistance": int(e["minDhashDistance"]),
                "sampleImagePairs": e["sampleImagePairs"],
            }
        )

    listing_edges.sort(
        key=lambda x: (-x["matchedImagePairs"], x["avgPhashDistance"], x["source"], x["target"])
    )

    listing_nodes = []
    listing_by_id: Dict[str, Dict[str, Any]] = {}
    for l in listings:
        lid = str(l.get("id", "")).strip()
        if not lid:
            continue
        listing_by_id[lid] = l

    for lid, l in listing_by_id.items():
        images = l.get("imageUrls") or []
        listing_nodes.append(
            {
                "id": lid,
                "title": l.get("title"),
                "price": l.get("price"),
                "beds": l.get("beds"),
                "baths": l.get("baths"),
                "sqft": l.get("sqft"),
                "imageCount": len(images) if isinstance(images, list) else 0,
                "url": l.get("url"),
            }
        )
    listing_nodes.sort(key=lambda x: x["id"])

    adjacency: Dict[str, Set[str]] = {n["id"]: set() for n in listing_nodes}
    for e in listing_edges:
        adjacency.setdefault(e["source"], set()).add(e["target"])
        adjacency.setdefault(e["target"], set()).add(e["source"])

    components: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    component_id = 0

    for lid in sorted(adjacency.keys()):
        if lid in seen:
            continue
        stack = [lid]
        members: List[str] = []
        seen.add(lid)
        while stack:
            cur = stack.pop()
            members.append(cur)
            for nxt in adjacency.get(cur, set()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        component_id += 1
        member_set = set(members)
        edge_count = sum(
            1
            for e in listing_edges
            if e["source"] in member_set and e["target"] in member_set
        )
        components.append(
            {
                "componentId": component_id,
                "size": len(members),
                "edgeCount": edge_count,
                "listingIds": sorted(members),
            }
        )

    components.sort(key=lambda c: (-c["size"], c["componentId"]))

    image_similarity_payload = {
        "generatedAt": utc_now_iso(),
        "thresholds": {
            "phashDistanceMax": phash_threshold,
            "dhashDistanceMax": dhash_threshold,
        },
        "totals": {
            "hashedImages": n,
            "pairComparisons": comparisons,
            "totalImageMatches": total_image_matches,
            "storedImageMatches": len(image_matches_output),
        },
        "matches": image_matches_output,
    }

    listing_graph_payload = {
        "generatedAt": utc_now_iso(),
        "thresholds": {
            "phashDistanceMax": phash_threshold,
            "dhashDistanceMax": dhash_threshold,
            "minEdgeSupport": min_edge_support,
        },
        "totals": {
            "nodes": len(listing_nodes),
            "edges": len(listing_edges),
            "components": len(components),
            "isolatedListings": sum(1 for c in components if c["size"] == 1),
        },
        "nodes": listing_nodes,
        "edges": listing_edges,
        "components": components,
    }

    return image_similarity_payload, listing_graph_payload


def apply_address_propagation(
    listing_graph: Dict[str, Any],
    seed_addresses: Dict[str, str],
) -> Dict[str, Any]:
    components = listing_graph.get("components", [])
    edges = listing_graph.get("edges", [])

    edge_lookup: Dict[Tuple[str, str], int] = {}
    for e in edges:
        a = str(e["source"])
        b = str(e["target"])
        key = (a, b) if a < b else (b, a)
        edge_lookup[key] = int(e.get("matchedImagePairs", 0))

    normalized_seed: Dict[str, Dict[str, str]] = {}
    for lid, address in seed_addresses.items():
        raw = str(address).strip()
        if not raw:
            continue
        normalized_seed[str(lid)] = {
            "raw": raw,
            "norm": normalize_address(raw),
        }

    by_norm_address: Dict[str, Dict[str, Any]] = {}
    listing_assignments: Dict[str, Dict[str, Any]] = {}
    conflict_components: List[Dict[str, Any]] = []
    inferred_total = 0

    for comp in components:
        listing_ids = [str(x) for x in comp.get("listingIds", [])]
        seeds_in_comp = [
            {"listingId": lid, **normalized_seed[lid]}
            for lid in listing_ids
            if lid in normalized_seed
        ]
        unique_norm = sorted({s["norm"] for s in seeds_in_comp})

        for seed in seeds_in_comp:
            entry = by_norm_address.setdefault(
                seed["norm"],
                {
                    "address": seed["raw"],
                    "normalizedAddress": seed["norm"],
                    "directListings": set(),
                    "inferredListings": set(),
                },
            )
            entry["directListings"].add(seed["listingId"])
            listing_assignments[seed["listingId"]] = {
                "address": seed["raw"],
                "normalizedAddress": seed["norm"],
                "source": "direct",
                "componentId": comp["componentId"],
                "confidence": 1.0,
            }

        if len(unique_norm) == 1:
            norm = unique_norm[0]
            addr = next(s["raw"] for s in seeds_in_comp if s["norm"] == norm)
            for lid in listing_ids:
                if lid in normalized_seed:
                    continue
                support = 0
                for seed in seeds_in_comp:
                    a, b = (lid, seed["listingId"]) if lid < seed["listingId"] else (seed["listingId"], lid)
                    support = max(support, edge_lookup.get((a, b), 0))
                confidence = min(1.0, 0.5 + 0.1 * support) if support > 0 else 0.5
                listing_assignments[lid] = {
                    "address": addr,
                    "normalizedAddress": norm,
                    "source": "inferred_component",
                    "componentId": comp["componentId"],
                    "confidence": round(confidence, 3),
                }
                by_norm_address[norm]["inferredListings"].add(lid)
                inferred_total += 1
        elif len(unique_norm) > 1:
            conflict_components.append(
                {
                    "componentId": comp["componentId"],
                    "listingIds": listing_ids,
                    "seedAddresses": sorted(
                        {s["raw"] for s in seeds_in_comp}
                    ),
                }
            )

    address_summary = []
    for row in by_norm_address.values():
        direct = sorted(row["directListings"])
        inferred = sorted(row["inferredListings"])
        address_summary.append(
            {
                "address": row["address"],
                "normalizedAddress": row["normalizedAddress"],
                "directListingCount": len(direct),
                "inferredListingCount": len(inferred),
                "totalListingCount": len(set(direct) | set(inferred)),
                "directListings": direct,
                "inferredListings": inferred,
            }
        )
    address_summary.sort(key=lambda x: (-x["totalListingCount"], x["address"]))

    return {
        "generatedAt": utc_now_iso(),
        "totals": {
            "seedListings": len(normalized_seed),
            "inferredListings": inferred_total,
            "assignedListings": len(listing_assignments),
            "addresses": len(address_summary),
            "conflictComponents": len(conflict_components),
        },
        "addressSummary": address_summary,
        "listingAssignments": listing_assignments,
        "conflictComponents": conflict_components,
    }


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Build perceptual image graph for listings")
    parser.add_argument("--listings", type=Path, default=root / "data" / "listings.json")
    parser.add_argument("--image-map", type=Path, default=root / "data" / "image-map.json")
    parser.add_argument("--downloads-dir", type=Path, default=root / "data" / "images-cache")
    parser.add_argument("--out-dir", type=Path, default=root / "data" / "hash-graph")

    parser.add_argument("--download-workers", type=int, default=24)
    parser.add_argument("--download-timeout", type=int, default=25)
    parser.add_argument("--download-retries", type=int, default=3)
    parser.add_argument("--skip-download", action="store_true")

    parser.add_argument("--phash-size", type=int, default=8)
    parser.add_argument("--dhash-size", type=int, default=8)
    parser.add_argument("--phash-threshold", type=int, default=8)
    parser.add_argument("--dhash-threshold", type=int, default=10)
    parser.add_argument("--min-edge-support", type=int, default=1)
    parser.add_argument("--max-image-matches-output", type=int, default=50000)

    parser.add_argument(
        "--seed-addresses",
        type=Path,
        nargs="*",
        default=[],
        help="Optional JSON file(s) with known listing->address mappings",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    listings = load_json(args.listings)
    image_map_payload = load_json(args.image_map)
    if not isinstance(listings, list):
        raise ValueError("listings.json must be a list")
    if not isinstance(image_map_payload, dict):
        raise ValueError("image-map.json must be an object")

    image_to_listing_ids = listing_image_index(listings)
    image_to_listing_ids_map = image_map_index(image_map_payload)
    for url, listing_ids in image_to_listing_ids_map.items():
        image_to_listing_ids[url].update(listing_ids)
    unique_urls = sorted(image_to_listing_ids.keys())
    print(
        f"[init] listings={len(listings)} uniqueImageUrls={len(unique_urls)} "
        f"(imageMapUrls={len(image_to_listing_ids_map)})"
    )

    if args.skip_download:
        download_rows = []
        for url in unique_urls:
            rel_path = relpath_for_url(url)
            p = args.downloads_dir / rel_path
            if p.exists() and p.stat().st_size > 0:
                st = p.stat()
                download_rows.append(
                    {
                        "url": url,
                        "relPath": rel_path,
                        "status": "cached",
                        "bytes": st.st_size,
                        "contentType": "",
                        "httpStatus": 200,
                        "error": None,
                        "mtimeNs": st.st_mtime_ns,
                    }
                )
            else:
                download_rows.append(
                    {
                        "url": url,
                        "relPath": rel_path,
                        "status": "error",
                        "bytes": 0,
                        "contentType": "",
                        "httpStatus": None,
                        "error": "missing cached file (skip-download set)",
                        "mtimeNs": None,
                    }
                )
    else:
        print(
            f"[download] starting workers={args.download_workers} "
            f"timeout={args.download_timeout}s retries={args.download_retries}"
        )
        download_rows = build_download_manifest(
            unique_urls,
            args.downloads_dir,
            workers=args.download_workers,
            timeout_sec=args.download_timeout,
            retries=args.download_retries,
        )

    hashes_path = args.out_dir / "image-hashes.json"
    cache = load_existing_hash_cache(hashes_path)
    hashed_rows = compute_hashes(
        download_rows,
        downloads_dir=args.downloads_dir,
        phash_size=args.phash_size,
        dhash_size=args.dhash_size,
        existing_cache=cache,
    )

    for row in hashed_rows:
        row["listingIds"] = sorted(image_to_listing_ids.get(row["url"], set()))

    download_errors = sum(1 for r in hashed_rows if r["status"] == "error")
    hash_errors = sum(
        1 for r in hashed_rows if r.get("hashStatus") in {"error", "missing_file"}
    )
    hash_ok = sum(1 for r in hashed_rows if r.get("hashStatus") in {"ok", "cached"})
    hash_payload = {
        "generatedAt": utc_now_iso(),
        "params": {
            "phashSize": args.phash_size,
            "dhashSize": args.dhash_size,
            "downloadsDir": str(args.downloads_dir),
        },
        "totals": {
            "uniqueImageUrls": len(unique_urls),
            "downloadErrors": download_errors,
            "hashOk": hash_ok,
            "hashErrors": hash_errors,
        },
        "images": hashed_rows,
    }
    write_json(hashes_path, hash_payload)
    print(
        f"[hash] wrote {hashes_path} "
        f"(ok={hash_ok}, downloadErrors={download_errors}, hashErrors={hash_errors})"
    )

    similarity_payload, listing_graph_payload = build_similarity_and_graph(
        hashed_rows=hashed_rows,
        listings=listings,
        image_to_listing_ids=image_to_listing_ids,
        phash_threshold=args.phash_threshold,
        dhash_threshold=args.dhash_threshold,
        min_edge_support=args.min_edge_support,
        max_image_matches_output=args.max_image_matches_output,
    )
    write_json(args.out_dir / "image-similarity.json", similarity_payload)
    write_json(args.out_dir / "listing-graph.json", listing_graph_payload)
    print(
        f"[graph] wrote listing graph: nodes={listing_graph_payload['totals']['nodes']} "
        f"edges={listing_graph_payload['totals']['edges']} "
        f"components={listing_graph_payload['totals']['components']}"
    )

    if args.seed_addresses:
        seeds, sources = load_seed_addresses(args.seed_addresses)
        propagation = apply_address_propagation(listing_graph_payload, seeds)
        propagation["seedSources"] = sources
        write_json(args.out_dir / "address-propagation.json", propagation)
        print(
            f"[address] wrote propagation for {len(seeds)} seed listings "
            f"(inferred={propagation['totals']['inferredListings']}, "
            f"conflicts={propagation['totals']['conflictComponents']})"
        )
    else:
        print("[address] no --seed-addresses provided; skipped propagation file")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:  # noqa: BLE001
        print(f"Fatal error: {exc}", file=sys.stderr)
        traceback.print_exc()
        raise SystemExit(1)
