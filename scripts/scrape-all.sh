#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
URLS_FILE="$ROOT_DIR/data/all-listing-urls.txt"
OUTPUT_DIR="$ROOT_DIR/.firecrawl/listings"
BATCH_SIZE=5

timestamp() {
  date '+%H:%M:%S'
}

flush_batch() {
  local batch_failures=0
  local i pid url outfile

  for i in "${!PIDS[@]}"; do
    pid="${PIDS[$i]}"
    url="${BATCH_URLS[$i]}"
    outfile="${BATCH_OUTFILES[$i]}"

    if wait "$pid"; then
      if [ ! -s "$outfile" ]; then
        echo "[$(timestamp)] ERROR: Empty scrape output for $url"
        rm -f "$outfile"
        batch_failures=$((batch_failures + 1))
      fi
    else
      echo "[$(timestamp)] ERROR: Scrape failed for $url"
      rm -f "$outfile"
      batch_failures=$((batch_failures + 1))
    fi
  done

  FAILED=$((FAILED + batch_failures))
  PIDS=()
  BATCH_URLS=()
  BATCH_OUTFILES=()
  BATCH_COUNT=0
}

if [ ! -f "$URLS_FILE" ]; then
  echo "[$(timestamp)] ERROR: URLs file not found: $URLS_FILE"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
TOTAL=$(wc -l < "$URLS_FILE" | tr -d ' ')
DONE=0
SKIPPED=0
FAILED=0
BATCH_COUNT=0
PIDS=()
BATCH_URLS=()
BATCH_OUTFILES=()

while IFS= read -r url || [ -n "$url" ]; do
  url="${url//$'\r'/}"
  [ -z "$url" ] && continue

  LID=$(printf '%s' "$url" | grep -oE '[0-9]+$' || true)
  if [ -z "$LID" ]; then
    echo "[$(timestamp)] ERROR: Could not extract listing ID from URL: $url"
    FAILED=$((FAILED + 1))
    DONE=$((DONE + 1))
    continue
  fi

  OUTFILE="${OUTPUT_DIR}/${LID}.md"
  if [ -f "$OUTFILE" ] && [ -s "$OUTFILE" ]; then
    SKIPPED=$((SKIPPED + 1))
    DONE=$((DONE + 1))
    continue
  fi

  firecrawl scrape "$url" -o "$OUTFILE" &
  PIDS+=("$!")
  BATCH_URLS+=("$url")
  BATCH_OUTFILES+=("$OUTFILE")
  BATCH_COUNT=$((BATCH_COUNT + 1))
  if [ "$BATCH_COUNT" -ge "$BATCH_SIZE" ]; then
    flush_batch
  fi
  DONE=$((DONE + 1))
  echo "[$(timestamp)] Progress: $DONE/$TOTAL (skipped $SKIPPED, failed $FAILED)"
done < "$URLS_FILE"

if [ "$BATCH_COUNT" -gt 0 ]; then
  flush_batch
fi

echo "[$(timestamp)] COMPLETE: $TOTAL total ($SKIPPED skipped, $FAILED failed)"
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
