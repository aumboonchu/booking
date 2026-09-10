PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'BRANCH')),
  branch_id INTEGER REFERENCES branches(id),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sell_price INTEGER NOT NULL CHECK (sell_price >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAUSED', 'INACTIVE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS round_parts (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  quota INTEGER,
  PRIMARY KEY (round_id, part_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  round_id TEXT NOT NULL REFERENCES rounds(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ALLOCATED', 'PREPARING', 'SHIPPED', 'RECEIVED', 'REJECTED', 'CANCELLED')),
  note TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  part_name_snapshot TEXT NOT NULL,
  sell_price_snapshot INTEGER NOT NULL,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  allocated_quantity INTEGER,
  item_note TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_branch ON orders(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_round ON orders(round_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

INSERT OR IGNORE INTO branches (id, name) VALUES
  (284, 'สาขา เซ็นทรัล Westville'),
  (286, 'สาขา เซ็นทรัล นครสวรรค์'),
  (287, 'สาขา เซียร์ เมกก้าช็อป E-TAX'),
  (288, 'สาขา เซ็นทรัล นครปฐม'),
  (289, 'สาขา กาฬสินธุ์ (CB)'),
  (291, 'สาขา เชียงใหม่ (Online)'),
  (292, 'สาขา ขอนแก่น (Online)'),
  (293, 'สาขา เดอะมอลล์โคราช (Online)'),
  (294, 'สาขา พัทยา (ตึกคอม) (Online)'),
  (295, 'สาขา สงขลา-หาดใหญ่ (Online)'),
  (296, 'สาขา JIB ONSITE SERVICE'),
  (297, 'สาขา JIB Mobile - Fashion Island'),
  (298, 'สาขา เซ็นทรัล พาร์ค'),
  (299, 'สาขา บึงกาฬ (CB)'),
  (300, 'สาขา ตราด (CB)'),
  (301, 'สาขา เซ็นทรัล กระบี่'),
  (302, 'สาขา ตาก (CB)'),
  (303, 'สาขา น่าน (CB)'),
  (306, 'สาขา หนองบัวลำภู (CB)'),
  (307, 'สาขา JIB Mobile เซ็นทรัลปิ่นเกล้า'),
  (309, 'สาขา เซ็นทรัลขอนแก่น แคมปัส'),
  (310, 'สาขา เซ็นทรัล Northville');
