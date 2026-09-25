import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";

function testDatabase(initialStatus, quantities = [1, 1]) {
  const order = { id: "request-1", status: initialStatus, sent_at: initialStatus === "SENT" ? "2026-09-20 10:00:00" : null, sent_by: initialStatus === "SENT" ? "admin-old" : null };
  const items = quantities.map((allocated_quantity, index) => ({ id: `item-${index + 1}`, requested_quantity: 1, allocated_quantity }));
  const logs = [];
  const DB = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (sql.includes("COUNT(*) AS count FROM users")) return { count: 1 };
          if (sql.includes("FROM sessions s JOIN users")) return { id: "admin-new", username: "UM", display_name: "Admin", role: "ADMIN", must_change_password: 0 };
          if (sql.includes("FROM demand_requests WHERE id = ?")) return { ...order };
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM demand_items WHERE request_id = ?")) return { results: items };
          throw new Error(`Unexpected all query: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO audit_logs")) logs.push({ action: this.args[2], detail: JSON.parse(this.args[5]) });
          else if (!sql.includes("UPDATE sessions SET last_seen_at")) throw new Error(`Unexpected run query: ${sql}`);
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        if (statement.sql.includes("UPDATE demand_items SET allocated_quantity")) items.find((item) => item.id === statement.args[2]).allocated_quantity = statement.args[0];
        else if (statement.sql.includes("UPDATE demand_requests SET status = ?")) {
          order.status = statement.args[0];
          if (statement.sql.includes("sent_at = NULL, sent_by = NULL")) { order.sent_at = null; order.sent_by = null; }
        } else throw new Error(`Unexpected batch query: ${statement.sql}`);
      }
      return [];
    },
  };
  return { DB, order, items, logs };
}

async function revise(db, values) {
  const request = new Request("https://example.test/api/admin/orders/request-1/allocation", {
    method: "PATCH",
    headers: { cookie: "jib_session=test-token", "content-type": "application/json" },
    body: JSON.stringify({ items: values.map((allocatedQuantity, index) => ({ itemId: `item-${index + 1}`, allocatedQuantity })), adminNote: "จำนวนของที่ได้รับจริง" }),
  });
  const response = await worker.fetch(request, { DB: db.DB });
  return { status: response.status, body: await response.json() };
}

test("a sent request can be corrected to partial allocation with its previous send recorded in audit", async () => {
  const db = testDatabase("SENT");
  const response = await revise(db, [1, 0]);
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "PARTIAL");
  assert.equal(db.order.status, "PARTIAL");
  assert.equal(db.order.sent_at, null);
  assert.equal(db.order.sent_by, null);
  assert.deepEqual(db.items.map((item) => item.allocated_quantity), [1, 0]);
  assert.equal(db.logs[0].action, "REVISE_ALLOCATION");
  assert.equal(db.logs[0].detail.previousStatus, "SENT");
  assert.equal(db.logs[0].detail.previousSentAt, "2026-09-20 10:00:00");
});

test("correcting a sent request to zero allocation returns it to pending", async () => {
  const db = testDatabase("SENT", [1]);
  const response = await revise(db, [0]);
  assert.equal(response.status, 200);
  assert.equal(db.order.status, "PENDING");
  assert.equal(db.order.sent_at, null);
});

test("a fully allocated request can be reduced to partial allocation", async () => {
  const db = testDatabase("ALLOCATED");
  const response = await revise(db, [0, 1]);
  assert.equal(response.status, 200);
  assert.equal(db.order.status, "PARTIAL");
  assert.equal(db.logs[0].detail.previousStatus, "ALLOCATED");
});

test("a cancelled request cannot be allocated", async () => {
  const db = testDatabase("CANCELLED");
  const response = await revise(db, [0, 0]);
  assert.equal(response.status, 409);
  assert.equal(db.order.status, "CANCELLED");
  assert.equal(db.logs.length, 0);
});
