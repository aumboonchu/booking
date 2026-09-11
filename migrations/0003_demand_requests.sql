CREATE TABLE IF NOT EXISTS demand_requests (
  id TEXT PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  customer_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PARTIAL', 'ALLOCATED', 'SENT', 'CANCELLED')),
  note TEXT,
  admin_note TEXT,
  allocated_at TEXT,
  allocated_by TEXT REFERENCES users(id),
  sent_at TEXT,
  sent_by TEXT REFERENCES users(id),
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS demand_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES demand_requests(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  part_name_snapshot TEXT NOT NULL,
  sell_price_snapshot INTEGER NOT NULL,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  allocated_quantity INTEGER NOT NULL DEFAULT 0 CHECK (allocated_quantity >= 0),
  item_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_demand_requests_branch ON demand_requests(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demand_requests_status ON demand_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demand_items_request ON demand_items(request_id);
