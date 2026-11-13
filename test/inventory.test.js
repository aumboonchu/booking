import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import vm from "node:vm";
import worker from "../src/index.js";
import { parseInventoryWorkbook, summarizeInventory } from "../public/inventory.js";

const xlsx = vm.runInNewContext(readFileSync(new URL("../public/vendor-xlsx.full.min.js", import.meta.url), "utf8") + "\nXLSX");
const headers = ["Branch", "Product", "Name", "Serial", "Number", "ราคารวมก่อน Vat", "ราคารวมหลัง Vat", "ประเภทสินค้า"];
const rows = [[21, "A-1", "Product A", "000019", 2, 20, 21.4, "Phone"], [112, "A-1", "Product A", "000020", 3, 30, 32.1, "Phone"], [21, "B-2", "Product B", "000021", 1, 30, 32.1, "Watch"]];

test("the workbook summary sums Number and line totals, preserves serials, and groups each branch", () => {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([headers, ...rows]), "Inventory");
  const parsed = parseInventoryWorkbook(xlsx, xlsx.write(workbook, { bookType: "xlsx", type: "array" }));
  assert.equal(parsed.rows[0][3], "000019");
  const summary = summarizeInventory(parsed.headers, parsed.rows);
  assert.equal(summary.units, 6);
  assert.equal(summary.products, 2);
  assert.equal(summary.beforeVat, 80);
  assert.equal(summary.afterVat, 85.6);
  assert.deepEqual(summary.branches.map(b => [b.branch, b.units]), [["21", 3], ["112", 3]]);
});

function database(role = "ADMIN") {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0009_inventory_snapshot.sql", import.meta.url), "utf8"));
  return { prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes("COUNT(*) AS count FROM users")) return { count: 1 };
        if (sql.includes("FROM sessions s JOIN users")) return { id: "user-1", username: "ADMIN", display_name: "Test Admin", role, must_change_password: 0 };
        return sqlite.prepare(sql).get(...args) ?? null;
      },
      async run() {
        if (!sql.includes("UPDATE sessions SET last_seen_at")) sqlite.prepare(sql).run(...args);
      },
    };
  }};
}

const request = (method, DB, body, cookie = "jib_session=test-token") => worker.fetch(new Request("https://example.test/api/admin/inventory", {
  method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), { DB });

test("a valid upload becomes the shared latest snapshot; an invalid upload keeps it", async () => {
  const DB = database();
  assert.deepEqual(await (await request("GET", DB)).json(), { snapshot: null });
  const upload = { filename: "first.xlsx", sheet: "Inventory", headers, rows };
  assert.equal((await request("PUT", DB, upload)).status, 200);
  const response = await request("GET", DB);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).snapshot.rows, rows);
  assert.equal((await request("PUT", DB, { ...upload, rows: [[21, "X", "Bad row", "x", "invalid", 1, 1, "Phone"]] })).status, 400);
  assert.equal((await (await request("GET", DB)).json()).snapshot.filename, "first.xlsx");
  assert.equal((await request("PUT", DB, { ...upload, filename: "second.xlsx", rows: [rows[0]] })).status, 200);
  assert.deepEqual((await (await request("GET", DB)).json()).snapshot.rows, [rows[0]]);
});

test("branch accounts cannot read or replace shared inventory", async () => {
  const DB = database("BRANCH");
  assert.equal((await request("GET", DB)).status, 403);
  assert.equal((await request("PUT", DB, { filename: "x.xlsx", sheet: "Inventory", headers, rows })).status, 403);
});
