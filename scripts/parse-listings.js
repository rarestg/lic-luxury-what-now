#!/usr/bin/env node
// Parse scraped listing markdown files into structured JSON
// Idempotent: can re-run safely, overwrites output

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const LISTINGS_DIR = path.join(ROOT_DIR, ".firecrawl", "listings");
const OUTPUT_FILE = path.join(ROOT_DIR, "data", "listings.json");
const IMAGE_MAP_FILE = path.join(ROOT_DIR, "data", "image-map.json");
const URLS_FILE = path.join(ROOT_DIR, "data", "all-listing-urls.txt");

function loadSourceUrlMap() {
  const byId = Object.create(null);
  if (!fs.existsSync(URLS_FILE)) return byId;

  const rows = fs.readFileSync(URLS_FILE, "utf8").split(/\r?\n/);
  for (const raw of rows) {
    const url = raw.trim().replace(/\r/g, "");
    if (!url) continue;
    const idMatch = url.match(/\/(\d+)\s*$/);
    if (!idMatch) continue;
    byId[idMatch[1]] = url;
  }
  return byId;
}

function parseListing(content, filename, sourceUrlById) {
  const id = path.basename(filename, ".md");

  // Extract title (first # heading)
  const titleMatch = content.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Extract price
  const priceMatch = content.match(/\$\s*([0-9,]+)/);
  const price = priceMatch ? Number.parseInt(priceMatch[1].replace(/,/g, "")) : null;

  // Extract beds/baths/sqft from line like "3 Beds • 2 Baths • 1,085 ft2"
  const bedsMatch = content.match(/(\d+)\s*Beds?/i);
  const bathsMatch = content.match(/(\d+)\s*Baths?/i);
  const sqftMatch = content.match(/([\d,]+)\s*ft2/i);

  const beds = bedsMatch ? Number.parseInt(bedsMatch[1]) : null;
  const baths = bathsMatch ? Number.parseInt(bathsMatch[1]) : null;
  const sqft = sqftMatch ? Number.parseInt(sqftMatch[1].replace(/,/g, "")) : null;

  // Extract property type and neighborhood
  const typeMatch = content.match(/^([A-Za-z][A-Za-z\/\- ]{1,40}?)\s+For\s+Rent$/im);
  const type = typeMatch ? typeMatch[1].trim().replace(/\s+/g, " ") : null;

  const neighborhoodMatch = content.match(/For Rent[\s\S]{0,50}?\[([^\]]+)\]\(.*?neighborhoods/);
  const neighborhood = neighborhoodMatch ? neighborhoodMatch[1].trim() : null;

  // Extract Web ID
  const webIdMatch = content.match(/Web ID\s*#?\s*(\d+)/);
  const webId = webIdMatch ? webIdMatch[1] : id;

  // Extract fee status
  const noFee = /No Fee/i.test(content);

  // Extract all image URLs (from realty.mx), deduplicated and sorted
  const imageUrls = [
    ...new Set(content.match(/https:\/\/images\.realty\.mx\/[^\s\)"\]]+\.jpg/g) || []),
  ].sort();

  // Extract features (between "Building & Unit Features" and next section)
  const featuresMatch = content.match(
    /### Building & Unit Features\n([\s\S]*?)(?=###|\nContact Agent|\nParking:)/,
  );
  const features = featuresMatch
    ? featuresMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("[") && !l.startsWith("#"))
    : [];

  // Extract description between "Contact Agent" and "Parking:" / "### Listing Agent".
  // Some pages place plain text here without an H3 heading, so heading is optional.
  const descMatch = content.match(
    /Contact Agent\s*\n+([\s\S]*?)(?=\nParking:|\n### Listing Agent)/i,
  );
  let description = descMatch ? descMatch[1].trim() : null;
  if (description) description = description.replace(/^### .+\n+/, "").trim();
  if (!description) description = null;

  // Extract parking
  const parkingMatch = content.match(/Parking:\s*\n(.+)/);
  const parking = parkingMatch ? parkingMatch[1].trim() : null;

  // Extract pet policy
  const petMatch = content.match(/Pet Policy:\s*(.+)/);
  const petPolicy = petMatch ? petMatch[1].trim() : null;

  // Resolve listing URL, preferring source URL list by id.
  const contentUrlMatch = content.match(
    /https:\/\/www\.luxuryapartmentslic\.com\/[a-z0-9\-\/]+\/\d+/i,
  );
  const contentUrl = contentUrlMatch ? contentUrlMatch[0].trim() : null;
  const url =
    sourceUrlById[id] ||
    contentUrl ||
    `https://www.luxuryapartmentslic.com/index.cfm?page=properties&id=${id}`;

  // Flags / things to watch out for
  const watchFlags = [];
  if (/model unit/i.test(content)) watchFlags.push("Photos are of a model unit");
  if (/promotional pricing/i.test(content)) watchFlags.push("May have promotional pricing");
  if (/Rent Stabilized/i.test(content)) watchFlags.push("Rent stabilized");
  if (/gross rent/i.test(content)) watchFlags.push("Gross rent listed (net may differ)");
  if (/net effective/i.test(content)) watchFlags.push("Net effective rent");
  if (/free (month|rent)/i.test(content)) watchFlags.push("Free rent concession");
  if (/guarantor/i.test(content)) watchFlags.push("May require guarantor");
  if (/income requirement/i.test(content)) watchFlags.push("Income requirements");

  return {
    id,
    webId,
    title,
    price,
    beds,
    baths,
    sqft,
    type,
    neighborhood,
    noFee,
    features,
    description,
    parking,
    petPolicy,
    watchFlags,
    imageUrls,
    url,
  };
}

function main() {
  const sourceUrlById = loadSourceUrlMap();
  const files = fs
    .readdirSync(LISTINGS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  console.log(`Parsing ${files.length} listing files...`);

  const listings = [];
  const imageMap = {}; // imageUrl -> [listingIds]

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(LISTINGS_DIR, file), "utf8");
      if (!content.trim()) continue;

      const listing = parseListing(content, file, sourceUrlById);
      listings.push(listing);

      // Build image map
      for (const imgUrl of listing.imageUrls) {
        if (!imageMap[imgUrl]) imageMap[imgUrl] = [];
        imageMap[imgUrl].push(listing.id);
      }
    } catch (e) {
      console.error(`Error parsing ${file}: ${e.message}`);
    }
  }

  // Sort by price descending
  listings.sort((a, b) => (b.price || 0) - (a.price || 0));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(listings, null, 2));
  fs.writeFileSync(IMAGE_MAP_FILE, JSON.stringify(imageMap, null, 2));

  console.log(`Written ${listings.length} listings to ${OUTPUT_FILE}`);
  console.log(`Written ${Object.keys(imageMap).length} unique images to ${IMAGE_MAP_FILE}`);

  // Stats
  const withSqft = listings.filter((l) => l.sqft).length;
  const withImages = listings.filter((l) => l.imageUrls.length > 0).length;
  const sharedImages = Object.entries(imageMap).filter(([, ids]) => ids.length > 1).length;
  console.log(
    `Stats: ${withSqft} with sqft, ${withImages} with images, ${sharedImages} shared image URLs`,
  );
}

main();
