// @ts-nocheck

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SESSION_DAYS = 12 * 60 * 60 * 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });

    try {
      const response = await route(request, env, url);
      return withCors(response, request);
    } catch (error) {
      console.error(JSON.stringify({ event: "api_error", message: error instanceof Error ? error.message : "Unknown error" }));
      const status = error instanceof AppError ? error.status : 500;
      const message = error instanceof AppError ? error.message : "เกิดข้อผิดพลาดในระบบ";
      return withCors(json({ error: message }, status), request);
    }
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  if (pathname === "/api/health") return json({ ok: true });
  if (pathname === "/api/setup-status" && request.method === "GET") {
    const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
    return json({ ready: Number(count) > 0 });
  }
  if (pathname === "/api/setup" && request.method === "POST") return setup(request, env);
  if (pathname === "/api/login" && request.method === "POST") return login(request, env);
  if (pathname === "/api/logout" && request.method === "POST") return logout(request, env);

  const user = await currentUser(request, env);
  if (pathname === "/api/me" && request.method === "GET") return json({ user: publicUser(user) });
  if (pathname === "/api/catalog" && request.method === "GET") return catalog(env);
  if (pathname === "/api/orders" && request.method === "GET") return listOrders(env, user);
  if (pathname === "/api/orders" && request.method === "POST") return createOrder(request, env, user);

  if (pathname === "/api/parts" && request.method === "GET") return listParts(env, user);
  if (pathname === "/api/parts" && request.method === "POST") return createPart(request, env, user);
  if (pathname === "/api/parts/import" && request.method === "POST") return importParts(request, env, user);
  const partMatch = pathname.match(/^\/api\/parts\/([^/]+)$/);
  if (partMatch && request.method === "PATCH") return updatePart(request, env, user, decodeURIComponent(partMatch[1]));
  if (partMatch && request.method === "DELETE") return removePart(env, user, decodeURIComponent(partMatch[1]));

  if (pathname === "/api/rounds" && request.method === "GET") return listRounds(env, user);
  if (pathname === "/api/rounds" && request.method === "POST") return createRound(request, env, user);
  const roundMatch = pathname.match(/^\/api\/rounds\/([^/]+)$/);
  const roundPartsGetMatch = pathname.match(/^\/api\/rounds\/([^/]+)\/parts$/);
  if (roundPartsGetMatch && request.method === "GET") return getRoundParts(env, user, decodeURIComponent(roundPartsGetMatch[1]));
  if (roundMatch && request.method === "PATCH") return updateRound(request, env, user, decodeURIComponent(roundMatch[1]));
  const roundPartMatch = pathname.match(/^\/api\/rounds\/([^/]+)\/parts$/);
  if (roundPartMatch && request.method === "PUT") return setRoundParts(request, env, user, decodeURIComponent(roundPartMatch[1]));

  if (pathname === "/api/admin/summary" && request.method === "GET") return summary(env, user);
  if (pathname === "/api/admin/orders" && request.method === "GET") return listAdminOrders(env, user);
  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (adminOrderMatch && request.method === "GET") return getAdminOrder(env, user, decodeURIComponent(adminOrderMatch[1]));
  const allocationMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/allocation$/);
  if (allocationMatch && request.method === "PATCH") return allocateOrder(request, env, user, decodeURIComponent(allocationMatch[1]));

  throw new AppError(404, "ไม่พบปลายทางที่ร้องขอ");
}

async function setup(request, env) {
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
  if (Number(count) > 0) throw new AppError(409, "ระบบถูกตั้งค่าแล้ว");
  const body = await bodyJson(request);
  if (!env.BOOTSTRAP_TOKEN || !timingSafeEqual(new TextEncoder().encode(String(body.setupToken || "")), new TextEncoder().encode(env.BOOTSTRAP_TOKEN))) throw new AppError(403, "รหัสตั้งค่าระบบไม่ถูกต้อง");
  const adminPassword = requiredPassword(body.adminPassword, "รหัสผ่านผู้ดูแล");
  const branchPassword = requiredPassword(body.branchPassword, "รหัสผ่านเริ่มต้นสาขา");
  const adminName = cleanText(body.adminName, 100) || "ผู้ดูแลระบบ";

  const statements = [];
  statements.push(await userInsertStatement(env, "ADMIN", adminName, "ADMIN", null, adminPassword));
  const branches = await env.DB.prepare("SELECT id, name FROM branches WHERE active = 1").all();
  for (const branch of branches.results) statements.push(await userInsertStatement(env, `BR${branch.id}`, branch.name, "BRANCH", branch.id, branchPassword));
  await env.DB.batch(statements);
  const admin = await env.DB.prepare("SELECT id, username, display_name, role, branch_id FROM users WHERE username = 'ADMIN'").first();
  return createLoginResponse(request, env, admin);
}

async function login(request, env) {
  const body = await bodyJson(request);
  const username = cleanText(body.username, 80).toUpperCase();
  const password = String(body.password || "");
  if (!username || !password) throw new AppError(400, "กรอกชื่อผู้ใช้และรหัสผ่าน");
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND active = 1").bind(username).first();
  if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) throw new AppError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
  return createLoginResponse(request, env, user);
}

async function logout(request, env) {
  const token = cookie(request, "jib_session");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": expireCookie() });
}

async function currentUser(request, env) {
  const token = cookie(request, "jib_session");
  if (!token) throw new AppError(401, "กรุณาเข้าสู่ระบบ");
  const user = await env.DB.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.branch_id, b.name AS branch_name
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN branches b ON b.id = u.branch_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`).bind(await sha256(token)).first();
  if (!user) throw new AppError(401, "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  return user;
}

async function listParts(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare("SELECT id, name, sell_price, status, created_at, updated_at FROM parts ORDER BY status = 'OPEN' DESC, id").all();
  return json({ parts: results });
}

async function createPart(request, env, user) {
  requireAdmin(user);
  const input = partInput(await bodyJson(request));
  const exists = await env.DB.prepare("SELECT id FROM parts WHERE id = ?").bind(input.id).first();
  if (exists) throw new AppError(409, "มีรหัส Part นี้แล้ว");
  await env.DB.prepare("INSERT INTO parts (id, name, sell_price, status) VALUES (?, ?, ?, ?)").bind(input.id, input.name, input.sellPrice, input.status).run();
  await audit(env, user, "CREATE", "PART", input.id, input);
  return json({ part: input }, 201);
}

async function updatePart(request, env, user, id) {
  requireAdmin(user);
  const current = await env.DB.prepare("SELECT * FROM parts WHERE id = ?").bind(id).first();
  if (!current) throw new AppError(404, "ไม่พบ Part");
  const body = await bodyJson(request);
  const input = partInput({ id, name: body.name ?? current.name, sellPrice: body.sellPrice ?? current.sell_price, status: body.status ?? current.status });
  await env.DB.prepare("UPDATE parts SET name = ?, sell_price = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(input.name, input.sellPrice, input.status, id).run();
  await audit(env, user, "UPDATE", "PART", id, input);
  return json({ part: input });
}

async function removePart(env, user, id) {
  requireAdmin(user);
  const part = await env.DB.prepare("SELECT id FROM parts WHERE id = ?").bind(id).first();
  if (!part) throw new AppError(404, "ไม่พบ Part");
  const used = await env.DB.prepare("SELECT 1 FROM order_items WHERE part_id = ? LIMIT 1").bind(id).first();
  if (used) {
    await env.DB.prepare("UPDATE parts SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    await audit(env, user, "INACTIVATE", "PART", id, { reason: "has_orders" });
    return json({ deleted: false, inactivated: true });
  }
  await env.DB.prepare("DELETE FROM parts WHERE id = ?").bind(id).run();
  await audit(env, user, "DELETE", "PART", id, null);
  return json({ deleted: true, inactivated: false });
}

async function importParts(request, env, user) {
  requireAdmin(user);
  const body = await bodyJson(request);
  if (!Array.isArray(body.rows) || body.rows.length === 0) throw new AppError(400, "ไม่พบข้อมูลสำหรับนำเข้า");
  if (body.rows.length > 2000) throw new AppError(400, "นำเข้าได้ครั้งละไม่เกิน 2,000 รายการ");
  const unique = new Map();
  const errors = [];
  for (const [index, row] of body.rows.entries()) {
    try {
      const input = partInput({ id: row.Product, name: row["Product Name"], sellPrice: row["Sell Price"], status: "OPEN" });
      if (unique.has(input.id)) throw new Error("รหัส Part ซ้ำในไฟล์");
      unique.set(input.id, input);
    } catch (error) { errors.push({ row: index + 2, message: error.message }); }
  }
  if (errors.length) return json({ valid: false, errors, inserted: 0, updated: 0 }, 422);
  const existingRows = await env.DB.prepare(`SELECT id FROM parts WHERE id IN (${[...unique.keys()].map(() => "?").join(",")})`).bind(...unique.keys()).all();
  const existing = new Set(existingRows.results.map((row) => row.id));
  const statements = [];
  let inserted = 0; let updated = 0;
  for (const part of unique.values()) {
    if (existing.has(part.id)) {
      statements.push(env.DB.prepare("UPDATE parts SET name = ?, sell_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(part.name, part.sellPrice, part.id));
      updated += 1;
    } else {
      statements.push(env.DB.prepare("INSERT INTO parts (id, name, sell_price, status) VALUES (?, ?, ?, 'OPEN')").bind(part.id, part.name, part.sellPrice));
      inserted += 1;
    }
  }
  await env.DB.batch(statements);
  await audit(env, user, "IMPORT", "PART", "batch", { inserted, updated });
  return json({ valid: true, inserted, updated, errors: [] });
}

async function listRounds(env, user) {
  if (user.role !== "ADMIN" && user.role !== "BRANCH") throw new AppError(403, "ไม่มีสิทธิ์เข้าถึง");
  const { results } = await env.DB.prepare(`SELECT r.*, COUNT(rp.part_id) AS part_count FROM rounds r
    LEFT JOIN round_parts rp ON rp.round_id = r.id GROUP BY r.id ORDER BY r.opens_at DESC`).all();
  return json({ rounds: results });
}

async function createRound(request, env, user) {
  requireAdmin(user);
  const body = await bodyJson(request);
  const name = cleanText(body.name, 100); const opensAt = cleanText(body.opensAt, 30); const closesAt = cleanText(body.closesAt, 30);
  const status = ["DRAFT", "OPEN", "CLOSED"].includes(body.status) ? body.status : "DRAFT";
  if (!name || !opensAt || !closesAt || new Date(opensAt) >= new Date(closesAt)) throw new AppError(400, "ตรวจสอบชื่อและช่วงเวลาเปิดรับ");
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO rounds (id, name, opens_at, closes_at, status) VALUES (?, ?, ?, ?, ?)").bind(id, name, opensAt, closesAt, status).run();
  await audit(env, user, "CREATE", "ROUND", id, { name, opensAt, closesAt, status });
  return json({ round: { id, name, opensAt, closesAt, status } }, 201);
}

async function updateRound(request, env, user, id) {
  requireAdmin(user);
  const current = await env.DB.prepare("SELECT * FROM rounds WHERE id = ?").bind(id).first();
  if (!current) throw new AppError(404, "ไม่พบรอบจอง");
  const body = await bodyJson(request);
  const name = cleanText(body.name ?? current.name, 100); const opensAt = cleanText(body.opensAt ?? current.opens_at, 30); const closesAt = cleanText(body.closesAt ?? current.closes_at, 30);
  const status = ["DRAFT", "OPEN", "CLOSED"].includes(body.status ?? current.status) ? (body.status ?? current.status) : null;
  if (!status || !name || new Date(opensAt) >= new Date(closesAt)) throw new AppError(400, "ข้อมูลรอบจองไม่ถูกต้อง");
  await env.DB.prepare("UPDATE rounds SET name = ?, opens_at = ?, closes_at = ?, status = ? WHERE id = ?").bind(name, opensAt, closesAt, status, id).run();
  await audit(env, user, "UPDATE", "ROUND", id, { name, opensAt, closesAt, status });
  return json({ round: { id, name, opensAt, closesAt, status } });
}

async function setRoundParts(request, env, user, roundId) {
  requireAdmin(user);
  const { parts } = await bodyJson(request);
  if (!Array.isArray(parts)) throw new AppError(400, "รูปแบบรายการสินค้าไม่ถูกต้อง");
  const statements = [env.DB.prepare("DELETE FROM round_parts WHERE round_id = ?").bind(roundId)];
  for (const item of parts) {
    const id = cleanText(item.partId, 100); const quota = item.quota === null || item.quota === "" ? null : Number(item.quota);
    if (!id || (quota !== null && (!Number.isInteger(quota) || quota < 0))) throw new AppError(400, "ข้อมูลสินค้าในรอบไม่ถูกต้อง");
    statements.push(env.DB.prepare("INSERT INTO round_parts (round_id, part_id, quota) VALUES (?, ?, ?)").bind(roundId, id, quota));
  }
  await env.DB.batch(statements);
  await audit(env, user, "SET_PARTS", "ROUND", roundId, { count: parts.length });
  return json({ ok: true });
}

async function getRoundParts(env, user, roundId) {
  requireAdmin(user);
  const { results } = await env.DB.prepare("SELECT part_id, quota FROM round_parts WHERE round_id = ? ORDER BY part_id").bind(roundId).all();
  return json({ parts: results });
}

async function catalog(env) {
  const { results } = await env.DB.prepare(`SELECT r.id AS round_id, r.name AS round_name, r.opens_at, r.closes_at,
    p.id, p.name, p.sell_price, rp.quota
    FROM rounds r JOIN round_parts rp ON rp.round_id = r.id JOIN parts p ON p.id = rp.part_id
    WHERE r.status = 'OPEN' AND p.status = 'OPEN' AND datetime(r.opens_at) <= datetime('now') AND datetime(r.closes_at) >= datetime('now')
    ORDER BY r.opens_at DESC, p.name`).all();
  return json({ items: results });
}

async function createOrder(request, env, user) {
  requireBranch(user);
  const body = await bodyJson(request);
  const roundId = cleanText(body.roundId, 80); const note = cleanText(body.note, 500);
  if (!roundId || !Array.isArray(body.items) || body.items.length === 0) throw new AppError(400, "เลือกสินค้าอย่างน้อย 1 รายการ");
  const round = await env.DB.prepare("SELECT id FROM rounds WHERE id = ? AND status = 'OPEN' AND datetime(opens_at) <= datetime('now') AND datetime(closes_at) >= datetime('now')").bind(roundId).first();
  if (!round) throw new AppError(409, "รอบจองปิดแล้วหรือไม่พร้อมใช้งาน");
  const ids = [...new Set(body.items.map((item) => cleanText(item.partId, 100)))];
  if (ids.length !== body.items.length || ids.some((id) => !id)) throw new AppError(400, "รายการสินค้าไม่ถูกต้อง");
  const products = await env.DB.prepare(`SELECT p.id, p.name, p.sell_price FROM round_parts rp JOIN parts p ON p.id = rp.part_id
    WHERE rp.round_id = ? AND p.status = 'OPEN' AND p.id IN (${ids.map(() => "?").join(",")})`).bind(roundId, ...ids).all();
  if (products.results.length !== ids.length) throw new AppError(409, "มีสินค้าที่ปิดรับจองหรือไม่อยู่ในรอบนี้");
  const byId = new Map(products.results.map((part) => [part.id, part]));
  const orderId = `PO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const statements = [env.DB.prepare("INSERT INTO orders (id, branch_id, round_id, note) VALUES (?, ?, ?, ?)").bind(orderId, user.branch_id, roundId, note || null)];
  for (const item of body.items) {
    const quantity = Number(item.quantity); const part = byId.get(item.partId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new AppError(400, "จำนวนที่ขอจองไม่ถูกต้อง");
    statements.push(env.DB.prepare("INSERT INTO order_items (id, order_id, part_id, part_name_snapshot, sell_price_snapshot, requested_quantity) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), orderId, part.id, part.name, part.sell_price, quantity));
  }
  await env.DB.batch(statements);
  await audit(env, user, "CREATE", "ORDER", orderId, { roundId, items: body.items.length });
  return json({ orderId }, 201);
}

async function listOrders(env, user) {
  const conditions = user.role === "BRANCH" ? "WHERE o.branch_id = ?" : "";
  const statement = env.DB.prepare(`SELECT o.*, b.name AS branch_name, r.name AS round_name,
    SUM(oi.requested_quantity) AS requested_total, SUM(COALESCE(oi.allocated_quantity, 0)) AS allocated_total
    FROM orders o JOIN branches b ON b.id = o.branch_id JOIN rounds r ON r.id = o.round_id JOIN order_items oi ON oi.order_id = o.id
    ${conditions} GROUP BY o.id ORDER BY o.created_at DESC`);
  const { results } = user.role === "BRANCH" ? await statement.bind(user.branch_id).all() : await statement.all();
  return json({ orders: results });
}

async function listAdminOrders(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare(`SELECT o.*, b.name AS branch_name, r.name AS round_name,
    SUM(oi.requested_quantity) AS requested_total, SUM(COALESCE(oi.allocated_quantity, 0)) AS allocated_total
    FROM orders o JOIN branches b ON b.id = o.branch_id JOIN rounds r ON r.id = o.round_id JOIN order_items oi ON oi.order_id = o.id
    GROUP BY o.id ORDER BY CASE o.status WHEN 'PENDING' THEN 0 ELSE 1 END, o.created_at ASC`).all();
  return json({ orders: results });
}

async function getAdminOrder(env, user, orderId) {
  requireAdmin(user);
  const order = await env.DB.prepare(`SELECT o.*, b.name AS branch_name, r.name AS round_name FROM orders o
    JOIN branches b ON b.id = o.branch_id JOIN rounds r ON r.id = o.round_id WHERE o.id = ?`).bind(orderId).first();
  if (!order) throw new AppError(404, "ไม่พบใบจอง");
  const { results: items } = await env.DB.prepare("SELECT id, part_id, part_name_snapshot, sell_price_snapshot, requested_quantity, allocated_quantity, item_note FROM order_items WHERE order_id = ? ORDER BY part_name_snapshot").bind(orderId).all();
  return json({ order, items });
}

async function allocateOrder(request, env, user, orderId) {
  requireAdmin(user);
  const body = await bodyJson(request);
  if (!Array.isArray(body.items) || body.items.length === 0) throw new AppError(400, "ต้องระบุจำนวนจัดสรร");
  const order = await env.DB.prepare("SELECT id FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) throw new AppError(404, "ไม่พบใบจอง");
  const source = await env.DB.prepare("SELECT id, requested_quantity FROM order_items WHERE order_id = ?").bind(orderId).all();
  const allowed = new Map(source.results.map((row) => [row.id, row.requested_quantity]));
  const statements = [];
  for (const item of body.items) {
    const quantity = Number(item.allocatedQuantity);
    if (!allowed.has(item.itemId) || !Number.isInteger(quantity) || quantity < 0 || quantity > allowed.get(item.itemId)) throw new AppError(400, "จำนวนจัดสรรไม่ถูกต้อง");
    statements.push(env.DB.prepare("UPDATE order_items SET allocated_quantity = ?, item_note = ? WHERE id = ? AND order_id = ?").bind(quantity, cleanText(item.note, 300) || null, item.itemId, orderId));
  }
  const status = ["ALLOCATED", "REJECTED"].includes(body.status) ? body.status : "ALLOCATED";
  statements.push(env.DB.prepare("UPDATE orders SET status = ?, admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, cleanText(body.adminNote, 500) || null, orderId));
  await env.DB.batch(statements);
  await audit(env, user, "ALLOCATE", "ORDER", orderId, { status, count: body.items.length });
  return json({ ok: true });
}

async function summary(env, user) {
  requireAdmin(user);
  const [orders, pending, allocated, branches] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS value FROM orders"),
    env.DB.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'PENDING'"),
    env.DB.prepare("SELECT COUNT(*) AS value FROM orders WHERE status = 'ALLOCATED'"),
    env.DB.prepare("SELECT COUNT(DISTINCT branch_id) AS value FROM orders"),
  ]);
  return json({ totalOrders: Number(orders.results[0].value), pendingOrders: Number(pending.results[0].value), allocatedOrders: Number(allocated.results[0].value), participatingBranches: Number(branches.results[0].value) });
}

function partInput(value) {
  const id = cleanText(value.id, 100).toUpperCase(); const name = cleanText(value.name, 300); const sellPrice = Number(value.sellPrice);
  const status = ["OPEN", "PAUSED", "INACTIVE"].includes(value.status) ? value.status : "OPEN";
  if (!id || !name || !Number.isInteger(sellPrice) || sellPrice < 0) throw new AppError(400, "ข้อมูล Part ไม่ถูกต้อง");
  return { id, name, sellPrice, status };
}

async function userInsertStatement(env, username, displayName, role, branchId, password) {
  const { salt, hash } = await hashPassword(password);
  return env.DB.prepare("INSERT INTO users (id, username, display_name, role, branch_id, password_salt, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), username, displayName, role, branchId, salt, hash);
}

async function createLoginResponse(request, env, user) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), user.id, expiresAt).run();
  await audit(env, user, "LOGIN", "USER", user.id, null);
  return json({ user: publicUser(user) }, 200, { "set-cookie": sessionCookie(token, new URL(request.url).protocol === "https:") });
}

async function audit(env, user, action, entityType, entityId, detail) {
  await env.DB.prepare("INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user?.id || null, action, entityType, entityId, detail ? JSON.stringify(detail) : null).run();
}

function publicUser(user) { return { id: user.id, username: user.username, displayName: user.display_name, role: user.role, branchId: user.branch_id, branchName: user.branch_name }; }
function requireAdmin(user) { if (user.role !== "ADMIN") throw new AppError(403, "เฉพาะผู้ดูแลระบบเท่านั้น"); }
function requireBranch(user) { if (user.role !== "BRANCH") throw new AppError(403, "เฉพาะบัญชีสาขาเท่านั้น"); }
function requiredPassword(value, label) { const password = String(value || ""); if (password.length < 12) throw new AppError(400, `${label}ต้องมีอย่างน้อย 12 ตัวอักษร`); return password; }
function cleanText(value, max) { return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : ""; }
async function bodyJson(request) { const length = Number(request.headers.get("content-length") || 0); if (length > 1_000_000) throw new AppError(413, "ข้อมูลมีขนาดใหญ่เกินไป"); try { return await request.json(); } catch { throw new AppError(400, "รูปแบบข้อมูลไม่ถูกต้อง"); } }
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } }); }
function cookie(request, name) { return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
function sessionCookie(token, secure) { return `jib_session=${token}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${SESSION_DAYS}`; }
function expireCookie() { return "jib_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }
function corsHeaders(request) { const origin = request.headers.get("origin"); return origin && origin === new URL(request.url).origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", vary: "origin" } : {}; }
function withCors(response, request) { const headers = new Headers(response.headers); for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value); return new Response(response.body, { status: response.status, headers }); }
async function hashPassword(password, suppliedSalt) { const salt = suppliedSalt || randomBase64(16); const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]); const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(salt), iterations: 210000 }, key, 256); return { salt, hash: toBase64(new Uint8Array(bits)) }; }
async function verifyPassword(password, salt, hash) { const candidate = await hashPassword(password, salt); return timingSafeEqual(fromBase64(candidate.hash), fromBase64(hash)); }
async function sha256(value) { return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function randomBase64(bytes) { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return toBase64(value); }
function toBase64(value) { return btoa(String.fromCharCode(...value)); }
function fromBase64(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function timingSafeEqual(left, right) { if (left.length !== right.length) return false; let result = 0; for (let index = 0; index < left.length; index += 1) result |= left[index] ^ right[index]; return result === 0; }
class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
