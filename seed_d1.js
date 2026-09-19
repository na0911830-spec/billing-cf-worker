/**
 * Node script to import items from items.json into Cloudflare D1
 * Database ID: dd615172-70ab-4a89-b11e-ae66cfaf4348
 *
 * Usage:
 *   npx wrangler d1 execute billing-db --file=./schema.sql --remote
 *   node seed_d1.js [batchSize] [maxItems]
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const itemsPath = path.join(__dirname, 'items.json');
  if (!fs.existsSync(itemsPath)) {
    console.error('items.json not found!');
    process.exit(1);
  }

  const rawData = fs.readFileSync(itemsPath, 'utf-8');
  const items = JSON.parse(rawData);

  console.log(`Loaded ${items.length} items from items.json.`);

  const maxItems = parseInt(process.argv[3] || '500', 10);
  const subset = items.slice(0, maxItems);

  // Generate SQL statements file
  let sql = 'BEGIN TRANSACTION;\n';
  let count = 0;

  for (const item of subset) {
    const barcode = (item.BARCODE || item.barcode || '').toString().trim();
    const name = (item.DESCA || item.name || '').toString().replace(/'/g, "''").trim();
    const mrp = Number(item.MRP || item.mrp || 0);
    const brand = (item.BRAND || item.brand || '').toString().replace(/'/g, "''").trim();
    const unit = (item.UNIT || item.unit || 'PCS').toString().replace(/'/g, "''").trim();
    const stock = Number(item.STOCK || item.stock || 0);

    if (barcode && name) {
      sql += `INSERT OR IGNORE INTO items (barcode, name, mrp, brand, unit, stock) VALUES ('${barcode}', '${name}', ${mrp}, '${brand}', '${unit}', ${stock});\n`;
      count++;
    }
  }

  sql += 'COMMIT;\n';

  const seedSqlFile = path.join(__dirname, 'seed.sql');
  fs.writeFileSync(seedSqlFile, sql);
  console.log(`Generated ${seedSqlFile} with ${count} items.`);
  console.log(`\nTo execute into Cloudflare D1, run:`);
  console.log(`npx wrangler d1 execute billing-db --file=./seed.sql --remote`);
}

main().catch(err => {
  console.error(err);
});
