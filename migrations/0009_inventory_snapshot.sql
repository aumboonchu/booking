CREATE TABLE IF NOT EXISTS inventory_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  filename TEXT NOT NULL,
  sheet TEXT NOT NULL,
  payload TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL
) STRICT;
