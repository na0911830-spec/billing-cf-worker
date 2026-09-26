-- Cloudflare D1 Schema for Billing Application
-- Database ID: dd615172-70ab-4a89-b11e-ae66cfaf4348

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    mrp REAL NOT NULL DEFAULT 0.0,
    unit TEXT DEFAULT 'PCS',
    stock REAL NOT NULL DEFAULT 0.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);

-- CUSTOMERS TABLE
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    address TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

-- BILLS / INVOICES TABLE
CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER,
    customer_name TEXT DEFAULT 'Cash Customer',
    customer_phone TEXT DEFAULT '',
    payment_mode TEXT DEFAULT 'Cash',
    subtotal REAL NOT NULL DEFAULT 0.0,
    discount_total REAL NOT NULL DEFAULT 0.0,
    grand_total REAL NOT NULL DEFAULT 0.0,
    amount_paid REAL NOT NULL DEFAULT 0.0,
    amount_due REAL NOT NULL DEFAULT 0.0,
    payment_status TEXT DEFAULT 'Paid', -- 'Paid', 'Unpaid', 'Partially Paid'
    total_qty REAL NOT NULL DEFAULT 0.0,
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bills_bill_number ON bills(bill_number);
CREATE INDEX IF NOT EXISTS idx_bills_created_at ON bills(created_at);
CREATE INDEX IF NOT EXISTS idx_bills_customer_phone ON bills(customer_phone);

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

-- ORDERS TABLE (Placed by customer, processed by seller)
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'processed', 'out_for_delivery', 'delivered', 'cancelled'
    subtotal REAL NOT NULL DEFAULT 0.0,
    grand_total REAL NOT NULL DEFAULT 0.0,
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    item_id INTEGER,
    barcode TEXT NOT NULL,
    name TEXT NOT NULL,
    mrp REAL NOT NULL,
    qty REAL NOT NULL DEFAULT 1.0,
    trade_disc REAL DEFAULT 0.0,
    disc REAL DEFAULT 0.0,
    final_amount REAL NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

