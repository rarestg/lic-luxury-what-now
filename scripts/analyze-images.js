const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const LISTINGS_FILE = path.join(ROOT_DIR, 'data', 'listings.json');
const d = JSON.parse(fs.readFileSync(LISTINGS_FILE, 'utf8'));

// Extract asset prefix (e.g. 72563 from 72563_18293.jpg) which might indicate building
const prefixMap = {};
d.forEach(l => {
  const prefixes = new Set(l.imageUrls.map(u => {
    const m = u.match(/(\d+)_\d+\.jpg/);
    return m ? m[1] : null;
  }).filter(Boolean));
  prefixes.forEach(p => {
    if (!prefixMap[p]) prefixMap[p] = [];
    prefixMap[p].push(l.id);
  });
});

// Show prefixes shared by multiple listings
const shared = Object.entries(prefixMap)
  .filter(([, ids]) => ids.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

console.log('Image asset prefix groups (same building?):', shared.length);
shared.slice(0, 20).forEach(([prefix, ids]) => {
  const sample = d.find(l => l.id === ids[0]);
  console.log(`  Prefix ${prefix} - ${ids.length} listings: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '...' : ''} | Street: ${sample?.title}`);
});

// Overall stats
console.log('\n--- Summary ---');
console.log('Total listings:', d.length);
console.log('With sqft:', d.filter(l => l.sqft).length);
console.log('With description:', d.filter(l => l.description).length);
console.log('Beds:', JSON.stringify(d.reduce((a, l) => { a[l.beds || '?'] = (a[l.beds || '?'] || 0) + 1; return a; }, {})));
console.log('Neighborhoods:', JSON.stringify(d.reduce((a, l) => { a[l.neighborhood || '?'] = (a[l.neighborhood || '?'] || 0) + 1; return a; }, {})));
console.log('Price range: $' + Math.min(...d.map(l => l.price || Infinity)).toLocaleString() + ' - $' + Math.max(...d.map(l => l.price || 0)).toLocaleString());
console.log('Unique image prefixes:', Object.keys(prefixMap).length);
console.log('Listings sharing image prefixes:', new Set(shared.flatMap(([, ids]) => ids)).size);
