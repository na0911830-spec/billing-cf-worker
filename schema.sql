-- Cloudflare D1 Schema for Billing Application
-- Database ID: dd615172-70ab-4a89-b11e-ae66cfaf4348

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    mrp REAL NOT NULL DEFAULT 0.0,
    brand TEXT DEFAULT '',
    unit TEXT DEFAULT 'PCS',
    stock REAL DEFAULT 0.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
CREATE INDEX IF NOT EXISTS idx_items_brand ON items(brand);

CREATE TABLE IF NOT EXISTS bills (
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
);

CREATE INDEX IF NOT EXISTS idx_bills_bill_number ON bills(bill_number);
CREATE INDEX IF NOT EXISTS idx_bills_created_at ON bills(created_at);

CREATE TABLE IF NOT EXISTS bill_items (
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
);

CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id ON bill_items(bill_id);
