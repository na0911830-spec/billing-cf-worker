/**
 * Cloudflare Worker Backend for Billing Application
 * D1 Database ID: dd615172-70ab-4a89-b11e-ae66cfaf4348
 * Binding: env.DB
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // 1. API: Items Endpoints
      if (pathname === '/api/items' && method === 'GET') {
        return await handleGetItems(env, searchParams);
      }

      if (pathname.startsWith('/api/items/barcode/') && method === 'GET') {
        const barcode = decodeURIComponent(pathname.replace('/api/items/barcode/', ''));
        return await handleGetItemByBarcode(env, barcode);
      }

      if (pathname === '/api/items' && method === 'POST') {
        const body = await request.json();
        return await handleCreateItem(env, body);
      }

      if (pathname.startsWith('/api/items/') && method === 'PUT') {
        const id = pathname.replace('/api/items/', '');
        const body = await request.json();
        return await handleUpdateItem(env, id, body);
      }

      if (pathname.startsWith('/api/items/') && method === 'DELETE') {
        const id = pathname.replace('/api/items/', '');
        return await handleDeleteItem(env, id);
      }

      // Batch import/seed
      if (pathname === '/api/items/seed' && method === 'POST') {
        const body = await request.json();
        return await handleSeedItems(env, body);
      }

      // 2. API: Bills Endpoints
      if (pathname === '/api/bills' && method === 'GET') {
        return await handleGetBills(env, searchParams);
      }

      if (pathname.startsWith('/api/bills/') && method === 'GET') {
        const idOrNumber = pathname.replace('/api/bills/', '');
        return await handleGetBillDetails(env, idOrNumber);
      }

      if (pathname.startsWith('/api/bills/') && method === 'DELETE') {
        const id = pathname.replace('/api/bills/', '');
        return await handleDeleteBill(env, id);
      }

      if (pathname === '/api/bills' && method === 'POST') {
        const body = await request.json();
        return await handleCreateBill(env, body);
      }

      // 3. Database Init / Migration Endpoint
      if (pathname === '/api/init-db' && (method === 'POST' || method === 'GET')) {
        return await handleInitDb(env);
      }

      // 4. Fallback or Embedded UI
      if (pathname === '/' || pathname === '/index.html') {
        return new Response(getAppHtml(), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            ...corsHeaders()
          }
        });
      }

      return jsonResponse({ error: 'Route not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || 'Internal Server Error', stack: err.stack }, 500);
    }
  }
};

/* ----------------- Discount & Calculation Utility ----------------- */
/**
 * Calculation rule:
 * base = mrp * qty
 * If tradedisc is provided (tradedisc > 0): base = base / tradedisc
 * If disc is provided (disc > 0): base = base * (1 - disc / 100)
 */
export function calculateItemTotal(mrp, qty, tradeDisc, discPercent) {
  const numMrp = Number(mrp) || 0;
  const numQty = Number(qty) || 0;
  const numTrade = Number(tradeDisc) || 0;
  const numDisc = Number(discPercent) || 0;

  let base = numMrp * numQty;

  if (numTrade > 0) {
    base = base / numTrade;
  }

  if (numDisc > 0) {
    base = base * (1 - (numDisc / 100));
  }

  return Math.round((base + Number.EPSILON) * 100) / 100;
}

/* ----------------- Route Handlers ----------------- */

async function handleInitDb(env) {
  if (!env.DB) {
    return jsonResponse({ error: 'D1 binding env.DB not found' }, 500);
  }

  const queries = [
    `CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      mrp REAL NOT NULL DEFAULT 0.0,
      brand TEXT DEFAULT '',
      unit TEXT DEFAULT 'PCS',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);`,
    `CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);`,
    `CREATE INDEX IF NOT EXISTS idx_items_brand ON items(brand);`,
    `CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT UNIQUE NOT NULL,
      customer_name TEXT DEFAULT 'Cash Customer',
      customer_phone TEXT DEFAULT '',
      payment_mode TEXT DEFAULT 'Cash',
      subtotal REAL NOT NULL DEFAULT 0.0,
      discount_total REAL NOT NULL DEFAULT 0.0,
      grand_total REAL NOT NULL DEFAULT 0.0,
      total_qty REAL NOT NULL DEFAULT 0.0,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE INDEX IF NOT EXISTS idx_bills_bill_number ON bills(bill_number);`,
    `CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL,
      item_id INTEGER,
      barcode TEXT NOT NULL,
      name TEXT NOT NULL,
      mrp REAL NOT NULL,
      qty REAL NOT NULL DEFAULT 1.0,
      trade_disc REAL DEFAULT 0.0,
      disc REAL DEFAULT 0.0,
      final_amount REAL NOT NULL,
      FOREIGN KEY(bill_id) REFERENCES bills(id) ON DELETE CASCADE
    );`,
    `CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id ON bill_items(bill_id);`
  ];

  for (const q of queries) {
    await env.DB.prepare(q).run();
  }

  return jsonResponse({ message: 'Database tables and indexes initialized successfully' });
}

async function handleGetItems(env, searchParams) {
  const query = searchParams.get('q') || '';
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM items';
  let countSql = 'SELECT COUNT(*) as total FROM items';
  const bindings = [];

  if (query.trim()) {
    const term = `%${query.trim()}%`;
    const filter = ' WHERE barcode LIKE ? OR name LIKE ? OR brand LIKE ?';
    sql += filter;
    countSql += filter;
    bindings.push(term, term, term);
  }

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  const dataBindings = [...bindings, limit, offset];

  const [itemsResult, countResult] = await Promise.all([
    env.DB.prepare(sql).bind(...dataBindings).all(),
    env.DB.prepare(countSql).bind(...bindings).first()
  ]);

  return jsonResponse({
    items: itemsResult.results || [],
    total: countResult ? countResult.total : 0,
    page,
    limit
  });
}

async function handleGetItemByBarcode(env, barcode) {
  const item = await env.DB.prepare('SELECT * FROM items WHERE barcode = ?').bind(barcode).first();
  if (!item) {
    return jsonResponse({ error: 'Item not found with barcode ' + barcode }, 404);
  }
  return jsonResponse({ item });
}

async function handleCreateItem(env, body) {
  const { barcode, name, mrp, brand, unit, stock } = body;
  if (!barcode || !name) {
    return jsonResponse({ error: 'Barcode and Name are required' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM items WHERE barcode = ?').bind(barcode).first();
  if (existing) {
    return jsonResponse({ error: `Item with barcode "${barcode}" already exists.` }, 409);
  }

  const insert = await env.DB.prepare(
    `INSERT INTO items (barcode, name, mrp, brand, unit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).bind(
    barcode.trim(),
    name.trim(),
    Number(mrp) || 0,
    (brand || '').trim(),
    unit || 'PCS',
    ).run();

  const newItem = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(insert.meta.last_row_id).first();
  return jsonResponse({ message: 'Item created', item: newItem }, 201);
}

async function handleUpdateItem(env, id, body) {
  const { barcode, name, mrp, brand, unit, stock } = body;
  const existing = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!existing) {
    return jsonResponse({ error: 'Item not found' }, 404);
  }

  if (barcode && barcode !== existing.barcode) {
    const dup = await env.DB.prepare('SELECT id FROM items WHERE barcode = ? AND id != ?').bind(barcode, id).first();
    if (dup) {
      return jsonResponse({ error: 'Barcode already in use by another item' }, 409);
    }
  }

  await env.DB.prepare(
    `UPDATE items SET
       barcode = ?,
       name = ?,
       mrp = ?,
       brand = ?,
       unit = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(
    (barcode || existing.barcode).trim(),
    (name || existing.name).trim(),
    mrp !== undefined ? Number(mrp) : existing.mrp,
    brand !== undefined ? brand.trim() : existing.brand,
    unit !== undefined ? unit : existing.unit,
    id
  ).run();

  const updated = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  return jsonResponse({ message: 'Item updated', item: updated });
}

async function handleDeleteItem(env, id) {
  const res = await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
  if (res.meta.changes === 0) {
    return jsonResponse({ error: 'Item not found' }, 404);
  }
  return jsonResponse({ message: 'Item deleted successfully' });
}

async function handleSeedItems(env, body) {
  const items = Array.isArray(body) ? body : (body.items || []);
  if (!items.length) {
    return jsonResponse({ error: 'No items provided for seeding' }, 400);
  }

  const batch = [];
  for (const it of items) {
    const barcode = it.BARCODE || it.barcode;
    const name = it.DESCA || it.name;
    const mrp = Number(it.MRP || it.mrp || 0);
    const brand = it.BRAND || it.brand || '';
    const unit = it.UNIT || it.unit || 'PCS';
    const stock = Number(it.STOCK || it.stock || 0);

    if (barcode && name) {
      batch.push(
        env.DB.prepare(
          `INSERT INTO items (barcode, name, mrp, brand, unit)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(barcode) DO UPDATE SET
             name=excluded.name,
             mrp=excluded.mrp,
             brand=excluded.brand,
             unit=excluded.unit,
             updated_at=CURRENT_TIMESTAMP`
        ).bind(barcode, name, mrp, brand, unit)
      );
    }
  }

  // D1 batch execution
  const results = await env.DB.batch(batch);
  return jsonResponse({ message: `Successfully seeded/updated ${results.length} items.` });
}

async function handleGetBills(env, searchParams) {
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);
  const offset = (page - 1) * limit;

  const [billsResult, countResult] = await Promise.all([
    env.DB.prepare('SELECT * FROM bills ORDER BY id DESC LIMIT ? OFFSET ?').bind(limit, offset).all(),
    env.DB.prepare('SELECT COUNT(*) as total FROM bills').first()
  ]);

  return jsonResponse({
    bills: billsResult.results || [],
    total: countResult ? countResult.total : 0,
    page,
    limit
  });
}

async function handleGetBillDetails(env, idOrNumber) {
  let bill = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(idOrNumber).first();
  if (!bill) {
    bill = await env.DB.prepare('SELECT * FROM bills WHERE bill_number = ?').bind(idOrNumber).first();
  }
  if (!bill) {
    return jsonResponse({ error: 'Bill not found' }, 404);
  }

  const itemsResult = await env.DB.prepare('SELECT * FROM bill_items WHERE bill_id = ?').bind(bill.id).all();
  return jsonResponse({
    bill,
    items: itemsResult.results || []
  });
}

async function handleCreateBill(env, body) {
  const { customer_name, customer_phone, payment_mode, notes, items } = body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return jsonResponse({ error: 'Bill must contain at least one item' }, 400);
  }

  // Generate unique bill number: BILL-YYYYMMDD-XXXX
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const billNumber = `BILL-${dateStr}-${randomSuffix}`;

  let rawSubtotal = 0;
  let calculatedGrandTotal = 0;
  let totalQty = 0;

  const processedItems = [];

  for (const it of items) {
    const mrp = Number(it.mrp) || 0;
    const qty = Number(it.qty) || 1;
    const tradeDisc = Number(it.trade_disc || it.tradedisc || 0);
    const disc = Number(it.disc || 0);

    const baseLine = mrp * qty;
    rawSubtotal += baseLine;
    totalQty += qty;

    const lineTotal = calculateItemTotal(mrp, qty, tradeDisc, disc);
    calculatedGrandTotal += lineTotal;

    processedItems.push({
      item_id: it.id || it.item_id || null,
      barcode: it.barcode || '',
      name: it.name || 'Unknown Item',
      mrp,
      qty,
      trade_disc: tradeDisc,
      disc,
      final_amount: lineTotal
    });
  }

  rawSubtotal = Math.round(rawSubtotal * 100) / 100;
  calculatedGrandTotal = Math.round(calculatedGrandTotal * 100) / 100;
  const discountTotal = Math.round((rawSubtotal - calculatedGrandTotal) * 100) / 100;

  // Insert bill into D1
  const billInsert = await env.DB.prepare(
    `INSERT INTO bills (bill_number, customer_name, customer_phone, payment_mode, subtotal, discount_total, grand_total, total_qty, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    billNumber,
    (customer_name || 'Cash Customer').trim(),
    (customer_phone || '').trim(),
    payment_mode || 'Cash',
    rawSubtotal,
    discountTotal,
    calculatedGrandTotal,
    totalQty,
    notes || ''
  ).run();

  const billId = billInsert.meta.last_row_id;

  // Insert bill items
  const itemInserts = processedItems.map(pi =>
    env.DB.prepare(
      `INSERT INTO bill_items (bill_id, item_id, barcode, name, mrp, qty, trade_disc, disc, final_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      billId,
      pi.item_id,
      pi.barcode,
      pi.name,
      pi.mrp,
      pi.qty,
      pi.trade_disc,
      pi.disc,
      pi.final_amount
    )
  );

  await env.DB.batch(itemInserts);

  const fullBill = await handleGetBillDetails(env, billId);
  return fullBill;
}

async function handleDeleteBill(env, idOrNumber) {
  // Find bill first
  let bill = null;
  if (/^\d+$/.test(idOrNumber)) {
    bill = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(Number(idOrNumber)).first();
  }
  if (!bill) {
    bill = await env.DB.prepare('SELECT * FROM bills WHERE bill_number = ?').bind(idOrNumber).first();
  }

  if (!bill) {
    return jsonResponse({ error: 'Bill not found' }, 404);
  }

  // Delete bill_items and bill
  await env.DB.batch([
    env.DB.prepare('DELETE FROM bill_items WHERE bill_id = ?').bind(bill.id),
    env.DB.prepare('DELETE FROM bills WHERE id = ?').bind(bill.id)
  ]);

  return jsonResponse({ message: 'Bill deleted successfully', id: bill.id, bill_number: bill.bill_number });
}

/* ----------------- Helpers & CORS ----------------- */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}

/* ----------------- Responsive Material 3 Expressive UI ----------------- */
function getAppHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>SmartPOS - Material 3 Expressive Billing</title>
  
  <!-- Material 3 Google Fonts & Icons -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,300;400;500;600;700&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/icon?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet">
  
  <!-- Camera Barcode Scanner for Mobile -->
  <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>

  <style>
    /* Material 3 Design Tokens */
    :root {
      --md-sys-color-primary: #006874;
      --md-sys-color-on-primary: #ffffff;
      --md-sys-color-primary-container: #97f0ff;
      --md-sys-color-on-primary-container: #001f24;
      --md-sys-color-secondary: #4a6267;
      --md-sys-color-on-secondary: #ffffff;
      --md-sys-color-secondary-container: #cce8ed;
      --md-sys-color-on-secondary-container: #051f23;
      --md-sys-color-tertiary: #525e7d;
      --md-sys-color-on-tertiary: #ffffff;
      --md-sys-color-tertiary-container: #dae2ff;
      --md-sys-color-on-tertiary-container: #0e1a37;
      --md-sys-color-error: #ba1a1a;
      --md-sys-color-on-error: #ffffff;
      --md-sys-color-error-container: #ffdad6;
      --md-sys-color-on-error-container: #410002;
      --md-sys-color-surface: #f4fbfb;
      --md-sys-color-on-surface: #161d1e;
      --md-sys-color-surface-variant: #dbe4e6;
      --md-sys-color-on-surface-variant: #3f484a;
      --md-sys-color-surface-container-lowest: #ffffff;
      --md-sys-color-surface-container-low: #edf5f5;
      --md-sys-color-surface-container: #e8efef;
      --md-sys-color-surface-container-high: #e2eaea;
      --md-sys-color-surface-container-highest: #dce4e4;
      --md-sys-color-outline: #6f797a;
      --md-sys-color-outline-variant: #bfc8ca;
      --md-sys-color-inverse-surface: #2b3132;
      --md-sys-color-inverse-on-surface: #ecf2f3;
      --md-sys-color-inverse-primary: #4fd8eb;

      --md-sys-typescale-body-font: 'Roboto Flex', sans-serif;
      --md-sys-typescale-title-font: 'Outfit', sans-serif;

      --md-sys-shape-corner-small: 8px;
      --md-sys-shape-corner-medium: 16px;
      --md-sys-shape-corner-large: 24px;
      --md-sys-shape-corner-full: 9999px;

      --md-elevation-1: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.08);
      --md-elevation-2: 0 4px 8px -1px rgba(0,0,0,0.08), 0 2px 4px -1px rgba(0,0,0,0.06);
      --md-elevation-3: 0 10px 20px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);

      --md-motion-standard: cubic-bezier(0.2, 0, 0, 1);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --md-sys-color-primary: #4fd8eb;
        --md-sys-color-on-primary: #00363d;
        --md-sys-color-primary-container: #004f58;
        --md-sys-color-on-primary-container: #97f0ff;
        --md-sys-color-secondary: #b1cbd0;
        --md-sys-color-on-secondary: #1c3438;
        --md-sys-color-secondary-container: #334b4f;
        --md-sys-color-on-secondary-container: #cce8ed;
        --md-sys-color-tertiary: #b9c6ea;
        --md-sys-color-on-tertiary: #24304d;
        --md-sys-color-tertiary-container: #3b4764;
        --md-sys-color-on-tertiary-container: #dae2ff;
        --md-sys-color-surface: #0e1415;
        --md-sys-color-on-surface: #deeaeb;
        --md-sys-color-surface-variant: #3f484a;
        --md-sys-color-on-surface-variant: #bfc8ca;
        --md-sys-color-surface-container-lowest: #090f10;
        --md-sys-color-surface-container-low: #161d1e;
        --md-sys-color-surface-container: #1b2122;
        --md-sys-color-surface-container-high: #252b2c;
        --md-sys-color-surface-container-highest: #303637;
        --md-sys-color-outline: #899294;
        --md-sys-color-outline-variant: #3f484a;
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: var(--md-sys-typescale-body-font);
      background-color: var(--md-sys-color-surface);
      color: var(--md-sys-color-on-surface);
      min-height: 100vh;
      overflow-x: hidden;
      display: flex;
    }

    .app-scaffold {
      display: flex;
      width: 100vw;
      min-height: 100vh;
      background: var(--md-sys-color-surface);
    }

    .nav-rail {
      width: 92px;
      background-color: var(--md-sys-color-surface-container);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px 8px;
      gap: 16px;
      border-right: 1px solid var(--md-sys-color-outline-variant);
      z-index: 10;
    }

    .brand-icon-wrap {
      width: 52px;
      height: 52px;
      background: var(--md-sys-color-primary-container);
      color: var(--md-sys-color-on-primary-container);
      border-radius: var(--md-sys-shape-corner-medium);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
    }

    .nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      color: var(--md-sys-color-on-surface-variant);
      cursor: pointer;
      width: 68px;
      padding: 8px 0;
      border-radius: var(--md-sys-shape-corner-medium);
      font-size: 11px;
      font-weight: 600;
      transition: all 0.2s var(--md-motion-standard);
    }

    .nav-item .icon-box {
      width: 56px;
      height: 32px;
      border-radius: var(--md-sys-shape-corner-full);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s;
    }

    .nav-item.active {
      color: var(--md-sys-color-on-surface);
    }

    .nav-item.active .icon-box {
      background-color: var(--md-sys-color-secondary-container);
      color: var(--md-sys-color-on-secondary-container);
    }

    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    .top-app-bar {
      height: 64px;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--md-sys-color-surface);
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
    }

    .top-app-bar h1 {
      font-family: var(--md-sys-typescale-title-font);
      font-size: 22px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .badge-d1 {
      font-size: 11px;
      padding: 4px 10px;
      background: var(--md-sys-color-tertiary-container);
      color: var(--md-sys-color-on-tertiary-container);
      border-radius: var(--md-sys-shape-corner-full);
      font-weight: 600;
    }

    .view-panel {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: none;
    }

    .view-panel.active {
      display: block;
    }

    .billing-grid {
      display: grid;
      grid-template-columns: 1fr 380px;
      gap: 20px;
      height: 100%;
    }

    @media (max-width: 960px) {
      .billing-grid {
        grid-template-columns: 1fr;
        height: auto;
      }
    }

    .m3-card {
      background: var(--md-sys-color-surface-container-low);
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-large);
      padding: 20px;
      position: relative;
    }

    .m3-field-wrap {
      position: relative;
      margin-bottom: 16px;
    }

    .m3-input {
      width: 100%;
      height: 52px;
      padding: 12px 16px;
      background: var(--md-sys-color-surface-container-highest);
      border: 1px solid var(--md-sys-color-outline);
      border-radius: var(--md-sys-shape-corner-small);
      color: var(--md-sys-color-on-surface);
      font-family: var(--md-sys-typescale-body-font);
      font-size: 15px;
      outline: none;
      transition: border 0.2s, box-shadow 0.2s;
    }

    .m3-input:focus {
      border-color: var(--md-sys-color-primary);
      border-width: 2px;
      box-shadow: 0 0 0 1px var(--md-sys-color-primary);
    }

    .m3-label {
      position: absolute;
      top: -9px;
      left: 12px;
      background: var(--md-sys-color-surface-container-highest);
      padding: 0 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--md-sys-color-primary);
      border-radius: 4px;
    }

    .m3-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 44px;
      padding: 0 20px;
      border-radius: var(--md-sys-shape-corner-full);
      font-family: var(--md-sys-typescale-body-font);
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: all 0.2s var(--md-motion-standard);
    }

    .m3-btn-primary {
      background-color: var(--md-sys-color-primary);
      color: var(--md-sys-color-on-primary);
      box-shadow: var(--md-elevation-1);
    }

    .m3-btn-primary:hover {
      box-shadow: var(--md-elevation-2);
      filter: brightness(1.05);
    }

    .m3-btn-tonal {
      background-color: var(--md-sys-color-secondary-container);
      color: var(--md-sys-color-on-secondary-container);
    }

    .m3-btn-tonal:hover {
      filter: brightness(0.95);
    }

    .m3-btn-outlined {
      background: transparent;
      border: 1px solid var(--md-sys-color-outline);
      color: var(--md-sys-color-primary);
    }

    .m3-btn-danger {
      background-color: var(--md-sys-color-error-container);
      color: var(--md-sys-color-on-error-container);
    }

    .m3-btn-sm {
      height: 34px;
      padding: 0 12px;
      font-size: 12px;
    }

    .barcode-search-box {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 20px;
    }

    .suggestions-list {
      position: absolute;
      top: 60px;
      left: 0;
      right: 0;
      background: var(--md-sys-color-surface-container-high);
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-medium);
      max-height: 260px;
      overflow-y: auto;
      z-index: 50;
      box-shadow: var(--md-elevation-3);
    }

    .suggestion-item {
      padding: 12px 16px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
    }

    .suggestion-item:hover {
      background: var(--md-sys-color-surface-container-highest);
    }

    .cart-table-wrap {
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-medium);
      overflow-x: auto;
      background: var(--md-sys-color-surface-container-lowest);
    }

    table.m3-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 14px;
    }

    table.m3-table th {
      background: var(--md-sys-color-surface-container);
      padding: 12px 14px;
      font-weight: 600;
      color: var(--md-sys-color-on-surface-variant);
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
    }

    table.m3-table td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--md-sys-color-outline-variant);
      vertical-align: middle;
    }

    .qty-input, .disc-input {
      width: 72px;
      height: 36px;
      padding: 4px 8px;
      background: var(--md-sys-color-surface-container-highest);
      border: 1px solid var(--md-sys-color-outline-variant);
      border-radius: var(--md-sys-shape-corner-small);
      color: var(--md-sys-color-on-surface);
      font-weight: 600;
      text-align: center;
    }

    .summary-card {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 100%;
    }

    .summary-line {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 15px;
    }

    .summary-grand {
      font-size: 24px;
      font-family: var(--md-sys-typescale-title-font);
      font-weight: 700;
      color: var(--md-sys-color-primary);
      border-top: 2px dashed var(--md-sys-color-outline-variant);
      padding-top: 14px;
      margin-top: 10px;
    }

    #scanner-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }

    #scanner-modal.open {
      display: flex;
    }

    .scanner-box {
      background: var(--md-sys-color-surface-container-high);
      border-radius: var(--md-sys-shape-corner-large);
      width: 100%;
      max-width: 440px;
      padding: 20px;
      box-shadow: var(--md-elevation-3);
      position: relative;
    }

    #reader {
      width: 100%;
      border-radius: var(--md-sys-shape-corner-medium);
      overflow: hidden;
    }

    #receipt-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      z-index: 999;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }

    #receipt-modal.open {
      display: flex;
    }

    .receipt-paper {
      background: #ffffff;
      color: #000000;
      padding: 24px;
      width: 100%;
      max-width: 380px;
      border-radius: 8px;
      font-family: 'Courier New', Courier, monospace;
      max-height: 85vh;
      overflow-y: auto;
    }

    @media (max-width: 600px) {
      body {
        flex-direction: column-reverse;
      }

      .app-scaffold {
        flex-direction: column-reverse;
      }

      .nav-rail {
        width: 100%;
        height: 64px;
        flex-direction: row;
        justify-content: space-around;
        padding: 0 8px;
        border-right: none;
        border-top: 1px solid var(--md-sys-color-outline-variant);
        position: fixed;
        bottom: 0;
        left: 0;
      }

      .brand-icon-wrap {
        display: none;
      }

      .nav-item {
        width: 64px;
        padding: 4px 0;
      }

      .nav-item .icon-box {
        width: 48px;
        height: 28px;
      }

      .main-content {
        height: calc(100vh - 64px);
        margin-bottom: 64px;
      }

      .top-app-bar {
        padding: 0 16px;
      }

      .view-panel {
        padding: 14px;
      }

      .phone-only-btn {
        display: inline-flex !important;
      }
    }

    @media (min-width: 601px) {
      .phone-only-btn {
        display: none !important;
      }
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: var(--md-sys-shape-corner-full);
      background: var(--md-sys-color-surface-container-highest);
      color: var(--md-sys-color-on-surface-variant);
    }
    
    .toast {
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--md-sys-color-inverse-surface);
      color: var(--md-sys-color-inverse-on-surface);
      padding: 10px 20px;
      border-radius: var(--md-sys-shape-corner-full);
      font-size: 14px;
      z-index: 2000;
      box-shadow: var(--md-elevation-3);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s;
    }
    .toast.show {
      opacity: 1;
    }
  </style>
</head>
<body>

<div class="app-scaffold">
  <nav class="nav-rail">
    <div class="brand-icon-wrap" title="SmartPOS Cloudflare D1">
      <span class="material-symbols-outlined" style="font-size: 28px;">point_of_sale</span>
    </div>
    
    <button class="nav-item active" onclick="switchTab('billing')">
      <div class="icon-box"><span class="material-symbols-outlined">receipt_long</span></div>
      <span>Billing</span>
    </button>
    
    <button class="nav-item" onclick="switchTab('inventory')">
      <div class="icon-box"><span class="material-symbols-outlined">inventory_2</span></div>
      <span>Items</span>
    </button>
    
    <button class="nav-item" onclick="switchTab('history')">
      <div class="icon-box"><span class="material-symbols-outlined">history</span></div>
      <span>Bills</span>
    </button>
  </nav>

  <main class="main-content">
    <header class="top-app-bar">
      <h1>
        <span class="material-symbols-outlined" style="color: var(--md-sys-color-primary)">storefront</span>
        SmartPOS
        <span class="badge-d1">Cloudflare D1</span>
      </h1>
    </header>

    <!-- 1. BILLING TAB -->
    <section id="tab-billing" class="view-panel active">
      <div class="billing-grid">
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div class="m3-card">
            <div class="barcode-search-box">
              <div class="m3-field-wrap" style="flex: 1; margin-bottom: 0;">
                <label class="m3-label">Scan Barcode / Search Item</label>
                <input type="text" id="barcode-input" class="m3-input" placeholder="Type barcode or item name & hit Enter..." autocomplete="off">
                <div id="item-suggestions" class="suggestions-list" style="display: none;"></div>
              </div>
              
              <button class="m3-btn m3-btn-primary" onclick="lookupBarcodeFromInput()">
                <span class="material-symbols-outlined">add_shopping_cart</span>
                <span>Add</span>
              </button>

              <button class="m3-btn m3-btn-tonal phone-only-btn" onclick="openScannerModal()" title="Scan with Phone Camera">
                <span class="material-symbols-outlined">barcode_scanner</span>
                <span>Scan</span>
              </button>
            </div>
            <div style="font-size: 12px; color: var(--md-sys-color-on-surface-variant); display: flex; gap: 12px;">
              <span>💡 Formula: <b>MRP × Qty</b> ÷ <i>trade_disc</i> − <i>disc%</i></span>
            </div>
          </div>

          <div class="cart-table-wrap">
            <table class="m3-table" id="cart-table">
              <thead>
                <tr>
                  <th>Item Details</th>
                  <th>MRP</th>
                  <th>Qty</th>
                  <th>Trade Disc (÷)</th>
                  <th>Disc (%)</th>
                  <th>Final Amount</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="cart-tbody">
                <tr>
                  <td colspan="7" style="text-align: center; color: var(--md-sys-color-outline); padding: 40px 10px;">
                    No items added to bill yet. Scan barcode or search above.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div class="m3-card summary-card">
            <div>
              <h2 style="font-family: var(--md-sys-typescale-title-font); font-size: 18px; margin-bottom: 16px;">
                Bill Details
              </h2>
              
              <div class="m3-field-wrap">
                <label class="m3-label">Customer Name</label>
                <input type="text" id="bill-cust-name" class="m3-input" value="Cash Customer">
              </div>

              <div class="m3-field-wrap">
                <label class="m3-label">Phone (Optional)</label>
                <input type="tel" id="bill-cust-phone" class="m3-input" placeholder="+91 9876543210">
              </div>

              <div class="m3-field-wrap">
                <label class="m3-label">Payment Mode</label>
                <select id="bill-payment-mode" class="m3-input">
                  <option value="Cash">Cash</option>
                  <option value="UPI / QR">UPI / QR Code</option>
                  <option value="Card">Card</option>
                  <option value="Credit">Credit / Due</option>
                </select>
              </div>

              <div style="margin: 20px 0; border-top: 1px solid var(--md-sys-color-outline-variant); padding-top: 14px;">
                <div class="summary-line">
                  <span>Total Items</span>
                  <span id="sum-items-count" style="font-weight: 600;">0</span>
                </div>
                <div class="summary-line">
                  <span>Gross Subtotal</span>
                  <span id="sum-subtotal">₹0.00</span>
                </div>
                <div class="summary-line" style="color: var(--md-sys-color-error);">
                  <span>Total Discount</span>
                  <span id="sum-discount">-₹0.00</span>
                </div>
                <div class="summary-line summary-grand">
                  <span>Net Payable</span>
                  <span id="sum-grand">₹0.00</span>
                </div>
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 20px;">
              <button class="m3-btn m3-btn-primary" style="height: 52px; font-size: 16px;" onclick="completeAndPrintBill()">
                <span class="material-symbols-outlined">receipt</span>
                <span>Generate Bill</span>
              </button>
              <button class="m3-btn m3-btn-outlined" onclick="clearCart()">
                <span class="material-symbols-outlined">delete_sweep</span>
                <span>Clear Bill</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 2. INVENTORY TAB -->
    <section id="tab-inventory" class="view-panel">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
        <div>
          <h2 style="font-family: var(--md-sys-typescale-title-font); font-size: 22px;">Items Catalog</h2>
          <p style="font-size: 13px; color: var(--md-sys-color-on-surface-variant);">Manage barcodes, brands, MRP, and stock in Cloudflare D1</p>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="m3-btn m3-btn-tonal" onclick="openItemModal()">
            <span class="material-symbols-outlined">add</span>
            <span>New Item</span>
          </button>
        </div>
      </div>

      <div class="m3-card" style="margin-bottom: 16px; padding: 12px 16px;">
        <div style="display: flex; gap: 12px;">
          <input type="text" id="inventory-search" class="m3-input" placeholder="Search by Barcode, Name, or Brand..." oninput="debounceSearchInventory()">
          <button class="m3-btn m3-btn-primary" onclick="loadInventory(1)">
            <span class="material-symbols-outlined">search</span>
          </button>
        </div>
      </div>

      <div class="cart-table-wrap">
        <table class="m3-table">
          <thead>
            <tr>
              <th>Barcode</th>
              <th>Name</th>
              <th>Brand</th>
              <th>MRP (₹)</th>
              <th>Unit</th>
                            <th>Actions</th>
            </tr>
          </thead>
          <tbody id="inventory-tbody">
            <tr><td colspan="7" style="text-align: center; padding: 20px;">Loading items...</td></tr>
          </tbody>
        </table>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;" id="inventory-pagination"></div>
    </section>

    <!-- 3. BILLS HISTORY TAB -->
    <section id="tab-history" class="view-panel">
      <div style="margin-bottom: 20px;">
        <h2 style="font-family: var(--md-sys-typescale-title-font); font-size: 22px;">Saved Invoices</h2>
        <p style="font-size: 13px; color: var(--md-sys-color-on-surface-variant);">Past bills stored in Cloudflare D1</p>
      </div>

      <div class="cart-table-wrap">
        <table class="m3-table">
          <thead>
            <tr>
              <th>Bill #</th>
              <th>Date & Time</th>
              <th>Customer</th>
              <th>Payment</th>
              <th>Items</th>
              <th>Grand Total</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="history-tbody">
            <tr><td colspan="7" style="text-align: center; padding: 20px;">Loading bills...</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</div>

<!-- Camera Barcode Scanner Modal -->
<div id="scanner-modal">
  <div class="scanner-box">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="font-size: 18px; font-weight: 600;">Scan Barcode</h3>
      <button class="m3-btn m3-btn-tonal m3-btn-sm" onclick="closeScannerModal()">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div id="reader"></div>
    <p style="font-size: 12px; color: var(--md-sys-color-outline); text-align: center; margin-top: 12px;">
      Point camera at barcode. Audio feedback on successful scan.
    </p>
  </div>
</div>

<!-- Item Add/Edit Modal -->
<div id="item-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000; align-items: center; justify-content: center; padding: 16px;">
  <div class="m3-card" style="width: 100%; max-width: 500px; background: var(--md-sys-color-surface-container-high);">
    <h3 id="item-modal-title" style="margin-bottom: 16px; font-family: var(--md-sys-typescale-title-font);">Add New Item</h3>
    <input type="hidden" id="edit-item-id">
    
    <div class="m3-field-wrap">
      <label class="m3-label">Barcode *</label>
      <input type="text" id="modal-barcode" class="m3-input" required placeholder="e.g. 8904109443084">
    </div>
    <div class="m3-field-wrap">
      <label class="m3-label">Item Name *</label>
      <input type="text" id="modal-name" class="m3-input" required placeholder="e.g. PAPAD KALI MIRCH">
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="m3-field-wrap">
        <label class="m3-label">MRP (₹) *</label>
        <input type="number" step="0.01" id="modal-mrp" class="m3-input" required placeholder="60.00">
      </div>
      <div class="m3-field-wrap">
        <label class="m3-label">Brand</label>
        <input type="text" id="modal-brand" class="m3-input" placeholder="e.g. PAPAD">
      </div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="m3-field-wrap">
        <label class="m3-label">Unit</label>
        <input type="text" id="modal-unit" class="m3-input" value="PCS">
      </div>

    </div>

    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
      <button class="m3-btn m3-btn-outlined" onclick="closeItemModal()">Cancel</button>
      <button class="m3-btn m3-btn-primary" onclick="saveItemFromModal()">Save Item</button>
    </div>
  </div>
</div>

<!-- Receipt Modal -->
<div id="receipt-modal">
  <div class="receipt-paper" id="receipt-content"></div>
</div>

<div id="toast" class="toast"></div>

<script>
  let cart = [];
  let scanner = null;
  let searchDebounceTimer = null;
  let currentInventoryPage = 1;
  let suggestionMap = {};

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('barcode-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupBarcodeFromInput();
      }
    });

    document.getElementById('barcode-input').addEventListener('input', (e) => {
      debounceSuggest(e.target.value);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.barcode-search-box')) {
        document.getElementById('item-suggestions').style.display = 'none';
      }
    });
  });

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  function switchTab(tab) {
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

    document.getElementById('tab-' + tab).classList.add('active');
    const idx = tab === 'billing' ? 0 : (tab === 'inventory' ? 1 : 2);
    document.querySelectorAll('.nav-item')[idx].classList.add('active');

    if (tab === 'inventory') {
      loadInventory(1);
    } else if (tab === 'history') {
      loadBillsHistory();
    }
  }

  async function initDatabase() {
    try {
      const res = await fetch('/api/init-db', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast('D1 Database tables initialized!');
      } else {
        alert('Init failed: ' + (data.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Error initializing D1: ' + e.message);
    }
  }

  function calculateLineTotal(mrp, qty, tradeDisc, disc) {
    mrp = Number(mrp) || 0;
    qty = Number(qty) || 0;
    tradeDisc = Number(tradeDisc) || 0;
    disc = Number(disc) || 0;

    let base = mrp * qty;
    if (tradeDisc > 0) {
      base = base / tradeDisc;
    }
    if (disc > 0) {
      base = base * (1 - (disc / 100));
    }
    return Math.round((base + Number.EPSILON) * 100) / 100;
  }

  async function lookupBarcodeFromInput() {
    const input = document.getElementById('barcode-input');
    const val = input.value.trim();
    if (!val) return;

    try {
      const res = await fetch('/api/items/barcode/' + encodeURIComponent(val));
      if (res.ok) {
        const data = await res.json();
        addItemToCart(data.item);
        input.value = '';
        document.getElementById('item-suggestions').style.display = 'none';
        return;
      }

      const searchRes = await fetch('/api/items?q=' + encodeURIComponent(val) + '&limit=1');
      const searchData = await searchRes.json();
      if (searchData.items && searchData.items.length > 0) {
        addItemToCart(searchData.items[0]);
        input.value = '';
        document.getElementById('item-suggestions').style.display = 'none';
      } else {
        showToast('Item not found for: ' + val);
      }
    } catch (e) {
      showToast('Error searching item: ' + e.message);
    }
  }

  function debounceSuggest(query) {
    clearTimeout(searchDebounceTimer);
    if (!query || query.length < 2) {
      document.getElementById('item-suggestions').style.display = 'none';
      return;
    }

    searchDebounceTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/items?q=' + encodeURIComponent(query) + '&limit=6');
        const data = await res.json();
        const container = document.getElementById('item-suggestions');
        if (!data.items || data.items.length === 0) {
          container.style.display = 'none';
          return;
        }

        suggestionMap = {};
        let html = '';
        for (const it of data.items) {
          suggestionMap[it.barcode] = it;
          html += '<div class="suggestion-item" onclick="selectSuggestedItem(\\'' + it.barcode + '\\')">'
            + '<div>'
            + '<div style="font-weight: 600;">' + escapeHtml(it.name) + '</div>'
            + '<div style="font-size: 11px; color: var(--md-sys-color-outline);">' + escapeHtml(it.barcode) + ' | ' + escapeHtml(it.brand || 'No Brand') + '</div>'
            + '</div>'
            + '<div style="font-weight: 700; color: var(--md-sys-color-primary);">₹' + Number(it.mrp).toFixed(2) + '</div>'
            + '</div>';
        }
        container.innerHTML = html;
        container.style.display = 'block';
      } catch (e) {
        console.error(e);
      }
    }, 250);
  }

  function selectSuggestedItem(barcode) {
    const item = suggestionMap[barcode];
    if (item) {
      addItemToCart(item);
    }
    document.getElementById('barcode-input').value = '';
    document.getElementById('item-suggestions').style.display = 'none';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function addItemToCart(item) {
    const existingIndex = cart.findIndex(c => c.barcode === item.barcode);
    if (existingIndex > -1) {
      cart[existingIndex].qty += 1;
    } else {
      cart.push({
        id: item.id,
        barcode: item.barcode,
        name: item.name,
        brand: item.brand,
        mrp: Number(item.mrp) || 0,
        qty: 1,
        trade_disc: 0,
        disc: 0
      });
    }
    renderCart();
    showToast('Added: ' + item.name);
  }

  function updateCartItem(index, field, value) {
    const val = Number(value) || 0;
    if (field === 'qty') {
      cart[index].qty = Math.max(0.01, val);
    } else if (field === 'trade_disc') {
      cart[index].trade_disc = val;
    } else if (field === 'disc') {
      cart[index].disc = Math.min(100, Math.max(0, val));
    }
    renderCart();
  }

  function removeCartItem(index) {
    cart.splice(index, 1);
    renderCart();
  }

  function clearCart() {
    cart = [];
    renderCart();
  }

  function renderCart() {
    const tbody = document.getElementById('cart-tbody');
    if (cart.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--md-sys-color-outline); padding: 40px 10px;">No items added to bill yet. Scan barcode or search above.</td></tr>';
      updateSummary(0, 0, 0);
      return;
    }

    let rawSubtotal = 0;
    let netTotal = 0;
    let totalQty = 0;

    let html = '';
    cart.forEach((item, idx) => {
      const lineTotal = calculateLineTotal(item.mrp, item.qty, item.trade_disc, item.disc);
      const grossLine = item.mrp * item.qty;

      rawSubtotal += grossLine;
      netTotal += lineTotal;
      totalQty += item.qty;

      html += '<tr>'
        + '<td>'
        + '<div style="font-weight: 600;">' + escapeHtml(item.name) + '</div>'
        + '<div style="font-size: 11px; color: var(--md-sys-color-outline);">' + escapeHtml(item.barcode) + (item.brand ? ' • ' + escapeHtml(item.brand) : '') + '</div>'
        + '</td>'
        + '<td style="font-weight: 500;">₹' + item.mrp.toFixed(2) + '</td>'
        + '<td><input type="number" step="any" min="0.01" class="qty-input" value="' + item.qty + '" onchange="updateCartItem(' + idx + ', \\'qty\\', this.value)"></td>'
        + '<td><input type="number" step="any" min="0" class="disc-input" value="' + (item.trade_disc || '') + '" placeholder="none" onchange="updateCartItem(' + idx + ', \\'trade_disc\\', this.value)" title="Divides (MRP x Qty) by this value"></td>'
        + '<td><input type="number" step="any" min="0" max="100" class="disc-input" value="' + (item.disc || '') + '" placeholder="0%" onchange="updateCartItem(' + idx + ', \\'disc\\', this.value)" title="Percent deducted from value"></td>'
        + '<td style="font-weight: 700; color: var(--md-sys-color-primary);">₹' + lineTotal.toFixed(2) + '</td>'
        + '<td><button class="m3-btn m3-btn-danger m3-btn-sm" onclick="removeCartItem(' + idx + ')"><span class="material-symbols-outlined" style="font-size: 16px;">delete</span></button></td>'
        + '</tr>';
    });

    tbody.innerHTML = html;
    updateSummary(totalQty, rawSubtotal, netTotal);
  }

  function updateSummary(qty, subtotal, net) {
    document.getElementById('sum-items-count').innerText = qty;
    document.getElementById('sum-subtotal').innerText = '₹' + subtotal.toFixed(2);
    const discount = Math.max(0, subtotal - net);
    document.getElementById('sum-discount').innerText = '-₹' + discount.toFixed(2);
    document.getElementById('sum-grand').innerText = '₹' + net.toFixed(2);
  }

  async function completeAndPrintBill() {
    if (cart.length === 0) {
      alert('Cart is empty. Add items before generating bill.');
      return;
    }

    const payload = {
      customer_name: document.getElementById('bill-cust-name').value || 'Cash Customer',
      customer_phone: document.getElementById('bill-cust-phone').value || '',
      payment_mode: document.getElementById('bill-payment-mode').value || 'Cash',
      items: cart
    };

    try {
      const res = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (!res.ok) {
        alert('Error creating bill: ' + (data.error || 'Server error'));
        return;
      }

      showReceiptModal(data.bill, data.items);
      clearCart();
    } catch (e) {
      alert('Bill creation failed: ' + e.message);
    }
  }

  function showReceiptModal(bill, items) {
    const modal = document.getElementById('receipt-modal');
    const content = document.getElementById('receipt-content');

    let itemsHtml = '';
    items.forEach(it => {
      itemsHtml += '<div>'
        + '<div style="font-weight: bold;">' + escapeHtml(it.name) + '</div>'
        + '<div style="display: flex; justify-content: space-between; font-size: 11px; color: #333;">'
        + '<span>' + it.qty + ' x ₹' + Number(it.mrp).toFixed(2) + (it.trade_disc ? ' [÷' + it.trade_disc + ']' : '') + (it.disc ? ' [-' + it.disc + '%]' : '') + '</span>'
        + '<span>₹' + Number(it.final_amount).toFixed(2) + '</span>'
        + '</div></div>';
    });

    content.innerHTML = '<div style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 12px; margin-bottom: 12px;">'
      + '<h2 style="font-size: 20px; font-weight: bold; margin-bottom: 4px;">SMART POS</h2>'
      + '<div>Cloudflare D1 Store</div>'
      + '<div style="font-size: 12px; margin-top: 4px;">Invoice: <b>' + escapeHtml(bill.bill_number) + '</b></div>'
      + '<div style="font-size: 11px;">Date: ' + new Date(bill.created_at).toLocaleString() + '</div>'
      + '</div>'
      + '<div style="font-size: 12px; margin-bottom: 12px;">'
      + '<div>Customer: ' + escapeHtml(bill.customer_name) + '</div>'
      + '<div>Payment: ' + escapeHtml(bill.payment_mode) + '</div>'
      + '</div>'
      + '<div style="border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 6px; font-size: 11px;">'
      + '<div style="display: flex; justify-content: space-between; font-weight: bold;">'
      + '<span>ITEM</span><span>QTY x MRP</span><span>TOTAL</span>'
      + '</div></div>'
      + '<div style="font-size: 12px; line-height: 1.5; border-bottom: 1px dashed #000; padding-bottom: 10px; margin-bottom: 10px;">'
      + itemsHtml
      + '</div>'
      + '<div style="font-size: 13px; line-height: 1.6; margin-bottom: 16px;">'
      + '<div style="display: flex; justify-content: space-between;"><span>Gross Total:</span><span>₹' + Number(bill.subtotal).toFixed(2) + '</span></div>'
      + '<div style="display: flex; justify-content: space-between;"><span>Discount:</span><span>-₹' + Number(bill.discount_total).toFixed(2) + '</span></div>'
      + '<div style="display: flex; justify-content: space-between; font-size: 16px; font-weight: bold; border-top: 1px solid #000; padding-top: 6px; margin-top: 6px;">'
      + '<span>Grand Total:</span><span>₹' + Number(bill.grand_total).toFixed(2) + '</span></div>'
      + '</div>'
      + '<div style="text-align: center; font-size: 11px; margin-bottom: 16px;">*** THANK YOU FOR VISITING! ***</div>'
      + '<div style="display: flex; gap: 8px;">'
      + '<button class="m3-btn m3-btn-primary" style="flex: 1;" onclick="window.print()">Print</button>'
      + '<button class="m3-btn m3-btn-outlined" style="flex: 1;" onclick="closeReceiptModal()">Close</button>'
      + '</div>';

    modal.classList.add('open');
  }

  function closeReceiptModal() {
    document.getElementById('receipt-modal').classList.remove('open');
  }

  function openScannerModal() {
    const modal = document.getElementById('scanner-modal');
    modal.classList.add('open');

    if (!scanner) {
      scanner = new Html5Qrcode("reader");
    }

    const config = { fps: 10, qrbox: { width: 250, height: 250 } };
    scanner.start(
      { facingMode: "environment" },
      config,
      onBarcodeScanned,
      (err) => {}
    ).catch(err => {
      alert("Camera error: " + err);
      closeScannerModal();
    });
  }

  async function onBarcodeScanned(decodedText) {
    playBeep();
    closeScannerModal();

    try {
      const res = await fetch('/api/items/barcode/' + encodeURIComponent(decodedText));
      if (res.ok) {
        const data = await res.json();
        addItemToCart(data.item);
      } else {
        showToast('Scanned: ' + decodedText + ' (Not found in catalog)');
        document.getElementById('barcode-input').value = decodedText;
      }
    } catch (e) {
      showToast('Scan error: ' + e.message);
    }
  }

  function closeScannerModal() {
    if (scanner && scanner.isScanning) {
      scanner.stop().then(() => {
        document.getElementById('scanner-modal').classList.remove('open');
      }).catch(() => {
        document.getElementById('scanner-modal').classList.remove('open');
      });
    } else {
      document.getElementById('scanner-modal').classList.remove('open');
    }
  }

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.15);
      setTimeout(() => { osc.stop(); ctx.close(); }, 150);
    } catch(e) {}
  }

  let inventoryMap = {};

  async function loadInventory(page = 1) {
    currentInventoryPage = page;
    const q = document.getElementById('inventory-search') ? document.getElementById('inventory-search').value : '';
    const tbody = document.getElementById('inventory-tbody');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">Fetching items from Cloudflare D1...</td></tr>';

    try {
      const res = await fetch('/api/items?q=' + encodeURIComponent(q) + '&page=' + page + '&limit=25');
      const data = await res.json();

      if (!data.items || data.items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">No items found. Click "New Item" to add.</td></tr>';
        return;
      }

      inventoryMap = {};
      let html = '';
      data.items.forEach(it => {
        inventoryMap[it.id] = it;
        html += '<tr>'
          + '<td><code>' + escapeHtml(it.barcode) + '</code></td>'
          + '<td style="font-weight: 600;">' + escapeHtml(it.name) + '</td>'
          + '<td>' + (it.brand ? escapeHtml(it.brand) : '<span style="color:var(--md-sys-color-outline)">-</span>') + '</td>'
          + '<td style="font-weight: 600;">₹' + Number(it.mrp).toFixed(2) + '</td>'
          + '<td>' + escapeHtml(it.unit) + '</td>'
         
          + '<td>'
          + '<div style="display: flex; gap: 6px;">'
          + '<button class="m3-btn m3-btn-tonal m3-btn-sm" onclick="editItemById(' + it.id + ')"><span class="material-symbols-outlined" style="font-size: 15px;">edit</span></button>'
          + '<button class="m3-btn m3-btn-danger m3-btn-sm" onclick="deleteItem(' + it.id + ')"><span class="material-symbols-outlined" style="font-size: 15px;">delete</span></button>'
          + '</div>'
          + '</td>'
          + '</tr>';
      });

      tbody.innerHTML = html;
      renderPagination(data.total, data.page, data.limit);
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: red;">Error: ' + e.message + '</td></tr>';
    }
  }

  function editItemById(id) {
    const item = inventoryMap[id];
    if (item) openItemModal(item);
  }

  function renderPagination(total, page, limit) {
    const container = document.getElementById('inventory-pagination');
    const totalPages = Math.ceil(total / limit) || 1;
    container.innerHTML = '<div style="font-size: 13px; color: var(--md-sys-color-on-surface-variant);">'
      + 'Showing ' + ((page - 1) * limit + 1) + ' to ' + Math.min(page * limit, total) + ' of ' + total + ' items'
      + '</div>'
      + '<div style="display: flex; gap: 8px;">'
      + '<button class="m3-btn m3-btn-outlined m3-btn-sm" ' + (page <= 1 ? 'disabled' : '') + ' onclick="loadInventory(' + (page - 1) + ')">Prev</button>'
      + '<span style="display: flex; align-items: center; padding: 0 8px; font-weight: 600;">' + page + ' / ' + totalPages + '</span>'
      + '<button class="m3-btn m3-btn-outlined m3-btn-sm" ' + (page >= totalPages ? 'disabled' : '') + ' onclick="loadInventory(' + (page + 1) + ')">Next</button>'
      + '</div>';
  }

  function debounceSearchInventory() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      loadInventory(1);
    }, 300);
  }

  function openItemModal(item) {
    document.getElementById('edit-item-id').value = item ? item.id : '';
    document.getElementById('item-modal-title').innerText = item ? 'Edit Item' : 'Add New Item';
    document.getElementById('modal-barcode').value = item ? item.barcode : '';
    document.getElementById('modal-name').value = item ? item.name : '';
    document.getElementById('modal-mrp').value = item ? item.mrp : '';
    document.getElementById('modal-brand').value = item ? item.brand : '';
    document.getElementById('modal-unit').value = item ? item.unit : 'PCS';
    
    document.getElementById('item-modal').style.display = 'flex';
  }

  function closeItemModal() {
    document.getElementById('item-modal').style.display = 'none';
  }

  async function saveItemFromModal() {
    const id = document.getElementById('edit-item-id').value;
    const body = {
      barcode: document.getElementById('modal-barcode').value.trim(),
      name: document.getElementById('modal-name').value.trim(),
      mrp: parseFloat(document.getElementById('modal-mrp').value) || 0,
      brand: document.getElementById('modal-brand').value.trim(),
      unit: document.getElementById('modal-unit').value.trim(),
          };

    if (!body.barcode || !body.name) {
      alert('Barcode and Item Name are required!');
      return;
    }

    try {
      const url = id ? '/api/items/' + id : '/api/items';
      const method = id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || 'Failed to save item');
        return;
      }

      showToast(id ? 'Item updated' : 'Item created');
      closeItemModal();
      loadInventory(currentInventoryPage);
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  async function deleteItem(id) {
    if (!confirm('Are you sure you want to delete this item?')) return;
    try {
      const res = await fetch('/api/items/' + id, { method: 'DELETE' });
      if (res.ok) {
        showToast('Item deleted');
        loadInventory(currentInventoryPage);
      } else {
        const err = await res.json();
        alert(err.error || 'Delete failed');
      }
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  async function loadBillsHistory() {
    const tbody = document.getElementById('history-tbody');
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">Loading bill records...</td></tr>';

    try {
      const res = await fetch('/api/bills?limit=50');
      const data = await res.json();

      if (!data.bills || data.bills.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">No bills created yet.</td></tr>';
        return;
      }

      let html = '';
      data.bills.forEach(b => {
        html += '<tr>'
          + '<td><b>' + escapeHtml(b.bill_number) + '</b></td>'
          + '<td>' + new Date(b.created_at).toLocaleString() + '</td>'
          + '<td>' + escapeHtml(b.customer_name) + '</td>'
          + '<td><span class="chip">' + escapeHtml(b.payment_mode) + '</span></td>'
          + '<td>' + b.total_qty + '</td>'
          + '<td style="font-weight: 700; color: var(--md-sys-color-primary);">₹' + Number(b.grand_total).toFixed(2) + '</td>'
          + '<td>'
          + '<div style="display: flex; gap: 6px;">'
          + '<button class="m3-btn m3-btn-tonal m3-btn-sm" onclick="viewPastBill(' + b.id + ')"><span class="material-symbols-outlined" style="font-size: 16px;">visibility</span></button>'
          + '<button class="m3-btn m3-btn-danger m3-btn-sm" onclick="deleteBill(' + b.id + ', \\'' + escapeHtml(b.bill_number) + '\\')"><span class="material-symbols-outlined" style="font-size: 16px;">delete</span></button>'
          + '</div>'
          + '</td>'
          + '</tr>';
      });

      tbody.innerHTML = html;
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: red;">Error: ' + e.message + '</td></tr>';
    }
  }

  async function viewPastBill(billId) {
    try {
      const res = await fetch('/api/bills/' + billId);
      const data = await res.json();
      if (res.ok) {
        showReceiptModal(data.bill, data.items);
      } else {
        alert('Could not fetch bill details');
      }
    } catch (e) {
      alert('Error: ' + e.message);
    }
  }

  async function deleteBill(billId, billNumber) {
    if (!confirm('Are you sure you want to permanently delete bill ' + (billNumber || billId) + ' from the server? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/bills/' + billId, { method: 'DELETE' });
      if (res.ok) {
        showToast('Bill deleted successfully');
        loadBillsHistory();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to delete bill');
      }
    } catch (e) {
      alert('Error deleting bill: ' + e.message);
    }
  }
</script>

</body>
</html>
`;
}
