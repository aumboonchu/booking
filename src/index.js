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
  await ensureDefaultUsers(env);
  if (pathname === "/api/setup-status" && request.method === "GET") {
    const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
    return json({ ready: Number(count) > 0 });
  }
  if (pathname === "/api/login" && request.method === "POST") return login(request, env);
  if (pathname === "/api/logout" && request.method === "POST") return logout(request, env);

  const user = await currentUser(request, env);
  if (pathname === "/api/me" && request.method === "GET") return json({ user: publicUser(user) });
  if (pathname === "/api/change-password" && request.method === "POST") return changePassword(request, env, user);
  if (user.must_change_password) throw new AppError(403, "กรุณาเปลี่ยนรหัสผ่านก่อนใช้งานระบบ");
  if (pathname === "/api/catalog" && request.method === "GET") return catalog(env);
  if (pathname === "/api/orders" && request.method === "GET") return listOrders(env, user);
  if (pathname === "/api/orders" && request.method === "POST") return createOrder(request, env, user);
  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && request.method === "GET") return getOrder(env, user, decodeURIComponent(orderMatch[1]));
  if (orderMatch && request.method === "PATCH") return updateOrder(request, env, user, decodeURIComponent(orderMatch[1]));
  if (orderMatch && request.method === "DELETE") return deleteBranchOrder(env, user, decodeURIComponent(orderMatch[1]));

  if (pathname === "/api/branches" && request.method === "GET") return listBranches(env, user);
  if (pathname === "/api/branches" && request.method === "POST") return createBranch(request, env, user);
  if (pathname === "/api/branches/import" && request.method === "POST") return importBranches(request, env, user);
  const branchSuspendMatch = pathname.match(/^\/api\/branches\/([^/]+)\/suspend$/);
  if (branchSuspendMatch && request.method === "POST") return suspendBranch(env, user, decodeURIComponent(branchSuspendMatch[1]));
  const branchResumeMatch = pathname.match(/^\/api\/branches\/([^/]+)\/resume$/);
  if (branchResumeMatch && request.method === "POST") return resumeBranch(env, user, decodeURIComponent(branchResumeMatch[1]));
  const branchAccessHistoryMatch = pathname.match(/^\/api\/branches\/([^/]+)\/access-history$/);
  if (branchAccessHistoryMatch && request.method === "GET") return branchAccessHistory(env, user, decodeURIComponent(branchAccessHistoryMatch[1]));
  const branchMatch = pathname.match(/^\/api\/branches\/([^/]+)$/);
  if (branchMatch && request.method === "PATCH") return updateBranch(request, env, user, decodeURIComponent(branchMatch[1]));
  if (branchMatch && request.method === "DELETE") return removeBranch(env, user, decodeURIComponent(branchMatch[1]));

  if (pathname === "/api/parts" && request.method === "GET") return listParts(env, user);
  if (pathname === "/api/parts" && request.method === "POST") return createPart(request, env, user);
  if (pathname === "/api/parts/import" && request.method === "POST") return importParts(request, env, user);
  const partMatch = pathname.match(/^\/api\/parts\/([^/]+)$/);
  if (partMatch && request.method === "PATCH") return updatePart(request, env, user, decodeURIComponent(partMatch[1]));
  if (partMatch && request.method === "DELETE") return removePart(env, user, decodeURIComponent(partMatch[1]));

  if (pathname === "/api/admin/summary" && request.method === "GET") return summary(env, user);
  if (pathname === "/api/admin/orders" && request.method === "GET") return listAdminOrders(env, user);
  if (pathname === "/api/admin/orders/export" && request.method === "GET") return listAdminExportRows(env, user);
  const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (adminOrderMatch && request.method === "GET") return getAdminOrder(env, user, decodeURIComponent(adminOrderMatch[1]));
  if (adminOrderMatch && request.method === "DELETE") return deleteAdminOrder(env, user, decodeURIComponent(adminOrderMatch[1]));
  const allocationMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/allocation$/);
  if (allocationMatch && request.method === "PATCH") return allocateOrder(request, env, user, decodeURIComponent(allocationMatch[1]));
  const sentMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/sent$/);
  if (sentMatch && request.method === "POST") return markOrderSent(env, user, decodeURIComponent(sentMatch[1]));

  throw new AppError(404, "ไม่พบปลายทางที่ร้องขอ");
}

async function ensureDefaultUsers(env) {
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();
  if (Number(count) > 0) return;
  const initialPassword = requiredPassword(env.INITIAL_PASSWORD, "รหัสผ่านเริ่มต้นระบบ");
  const credential = await hashPassword(initialPassword);
  const statements = [];
  statements.push(userInsertStatement(env, "UM", "um", "ADMIN", null, credential, true));
  const branches = await env.DB.prepare("SELECT id, name FROM branches WHERE active = 1").all();
  if (!branches.results.length) throw new AppError(503, "ยังไม่พบข้อมูลสาขาในระบบ");
  for (const branch of branches.results) statements.push(userInsertStatement(env, `JIB${branch.id}`, branch.name, "BRANCH", branch.id, credential, true));
  await env.DB.batch(statements);
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

async function changePassword(request, env, user) {
  const body = await bodyJson(request);
  const password = requiredPassword(body.password, "รหัสผ่านใหม่");
  const credential = await hashPassword(password);
  await env.DB.prepare("UPDATE users SET password_salt = ?, password_hash = ?, must_change_password = 0 WHERE id = ?").bind(credential.salt, credential.hash, user.id).run();
  await audit(env, user, "CHANGE_PASSWORD", "USER", user.id, null);
  return json({ user: publicUser({ ...user, must_change_password: 0 }) });
}

async function logout(request, env) {
  const token = cookie(request, "jib_session");
  if (token) await env.DB.prepare("UPDATE sessions SET logged_out_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND logged_out_at IS NULL").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": expireCookie() });
}

async function currentUser(request, env) {
  const token = cookie(request, "jib_session");
  if (!token) throw new AppError(401, "กรุณาเข้าสู่ระบบ");
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.branch_id, u.must_change_password, b.name AS branch_name
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN branches b ON b.id = u.branch_id
    WHERE s.token_hash = ? AND s.logged_out_at IS NULL AND datetime(s.expires_at) > datetime('now') AND u.active = 1`).bind(tokenHash).first();
  if (!user) throw new AppError(401, "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  const access = clientAccess(request);
  await env.DB.prepare("UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP, network_asn = COALESCE(network_asn, ?), network_isp = COALESCE(network_isp, ?) WHERE token_hash = ?").bind(access.networkAsn, access.networkIsp, tokenHash).run();
  return user;
}

async function listBranches(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare(`SELECT b.id, b.name, b.status, u.username,
    MAX(CASE WHEN s.logged_out_at IS NULL AND datetime(s.expires_at) > datetime('now')
      AND COALESCE(s.last_seen_at, s.created_at) >= datetime('now', '-15 minutes') THEN 1 ELSE 0 END) AS is_online,
    MAX(COALESCE(s.last_seen_at, s.created_at)) AS last_access_at
    FROM branches b
    LEFT JOIN users u ON u.branch_id = b.id AND u.role = 'BRANCH'
    LEFT JOIN sessions s ON s.user_id = u.id
    WHERE b.status != 'REMOVED'
    GROUP BY b.id, b.name, b.status, u.username
    ORDER BY b.id`).all();
  return json({ branches: results });
}

async function branchAccessHistory(env, user, branchId) {
  requireAdmin(user);
  const id = Number(branchId);
  if (!Number.isSafeInteger(id)) throw new AppError(404, "ไม่พบสาขา");
  const branch = await env.DB.prepare(`SELECT b.id, b.name, b.status, u.username
    FROM branches b LEFT JOIN users u ON u.branch_id = b.id AND u.role = 'BRANCH'
    WHERE b.id = ? AND b.status != 'REMOVED'`).bind(id).first();
  if (!branch) throw new AppError(404, "ไม่พบสาขา");
  const { results: sessions } = await env.DB.prepare(`SELECT s.created_at, s.last_seen_at, s.logged_out_at, s.expires_at,
    s.ip_address, s.network_asn, s.network_isp, s.user_agent,
    CASE WHEN s.logged_out_at IS NULL AND datetime(s.expires_at) > datetime('now')
      AND COALESCE(s.last_seen_at, s.created_at) >= datetime('now', '-15 minutes') THEN 1 ELSE 0 END AS is_online
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE u.branch_id = ? AND u.role = 'BRANCH'
    ORDER BY s.created_at DESC LIMIT 30`).bind(id).all();
  return json({ branch, sessions });
}

async function createBranch(request, env, user) {
  requireAdmin(user);
  const input = branchInput(await bodyJson(request));
  const exists = await env.DB.prepare("SELECT id FROM branches WHERE id = ?").bind(input.id).first();
  if (exists) throw new AppError(409, "มีรหัสสาขานี้แล้ว");
  const credential = await hashPassword(requiredPassword(env.INITIAL_PASSWORD, "รหัสผ่านเริ่มต้นระบบ"));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO branches (id, name, active, status) VALUES (?, ?, 1, 'ACTIVE')").bind(input.id, input.name),
    userInsertStatement(env, `JIB${input.id}`, input.name, "BRANCH", input.id, credential, true),
  ]);
  await audit(env, user, "CREATE", "BRANCH", String(input.id), input);
  return json({ branch: { ...input, username: `JIB${input.id}` } }, 201);
}

async function updateBranch(request, env, user, branchId) {
  requireAdmin(user);
  const id = Number(branchId);
  const current = await env.DB.prepare("SELECT id, name FROM branches WHERE id = ? AND status != 'REMOVED'").bind(id).first();
  if (!current) throw new AppError(404, "ไม่พบสาขา");
  const input = branchInput({ id, name: (await bodyJson(request)).name });
  await env.DB.batch([
    env.DB.prepare("UPDATE branches SET name = ? WHERE id = ?").bind(input.name, id),
    env.DB.prepare("UPDATE users SET display_name = ? WHERE branch_id = ?").bind(input.name, id),
  ]);
  await audit(env, user, "UPDATE", "BRANCH", String(id), input);
  return json({ branch: { ...input, username: `JIB${id}` } });
}

async function removeBranch(env, user, branchId) {
  requireAdmin(user);
  const id = Number(branchId);
  const branch = await env.DB.prepare("SELECT id, name FROM branches WHERE id = ? AND status != 'REMOVED'").bind(id).first();
  if (!branch) throw new AppError(404, "ไม่พบสาขา");
  await env.DB.batch([
    env.DB.prepare("UPDATE branches SET active = 0, status = 'REMOVED' WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE users SET active = 0 WHERE branch_id = ?").bind(id),
  ]);
  await audit(env, user, "REMOVE", "BRANCH", String(id), { id, name: branch.name });
  return json({ removed: true });
}

async function suspendBranch(env, user, branchId) {
  requireAdmin(user);
  const id = Number(branchId);
  const branch = await env.DB.prepare("SELECT id, name, status FROM branches WHERE id = ? AND status != 'REMOVED'").bind(id).first();
  if (!branch) throw new AppError(404, "ไม่พบสาขา");
  if (branch.status === "SUSPENDED") return json({ suspended: true, unchanged: true });
  await env.DB.batch([
    env.DB.prepare("UPDATE branches SET active = 0, status = 'SUSPENDED' WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE users SET active = 0 WHERE branch_id = ?").bind(id),
  ]);
  await audit(env, user, "SUSPEND", "BRANCH", String(id), { id, name: branch.name });
  return json({ suspended: true });
}

async function resumeBranch(env, user, branchId) {
  requireAdmin(user);
  const id = Number(branchId);
  const branch = await env.DB.prepare("SELECT id, name, status FROM branches WHERE id = ? AND status = 'SUSPENDED'").bind(id).first();
  if (!branch) throw new AppError(404, "ไม่พบสาขาที่ระงับใช้งาน");
  await env.DB.batch([
    env.DB.prepare("UPDATE branches SET active = 1, status = 'ACTIVE' WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE users SET active = 1 WHERE branch_id = ?").bind(id),
  ]);
  await audit(env, user, "RESUME", "BRANCH", String(id), { id, name: branch.name });
  return json({ resumed: true });
}

async function importBranches(request, env, user) {
  requireAdmin(user);
  const body = await bodyJson(request);
  if (!Array.isArray(body.rows) || body.rows.length === 0) throw new AppError(400, "ไม่พบข้อมูลสาขาสำหรับนำเข้า");
  if (body.rows.length > 2000) throw new AppError(400, "นำเข้าได้ครั้งละไม่เกิน 2,000 สาขา");

  const unique = new Map();
  const errors = [];
  for (const [index, row] of body.rows.entries()) {
    try {
      const input = branchInput(row);
      if (unique.has(input.id)) throw new Error("รหัสสาขาซ้ำในไฟล์");
      unique.set(input.id, input);
    } catch (error) {
      errors.push({ row: index + 2, message: error instanceof Error ? error.message : "ข้อมูลสาขาไม่ถูกต้อง" });
    }
  }
  if (errors.length) {
    const details = errors.slice(0, 10).map((error) => `แถว ${error.row}: ${error.message}`).join(" · ");
    return json({ error: `พบข้อมูลไม่ถูกต้อง ${errors.length} แถว: ${details}`, errors }, 422);
  }

  const ids = [...unique.keys()];
  const existingBranches = new Map();
  for (const group of chunk(ids, 100)) {
    const branchRows = await env.DB.prepare(`SELECT id, active FROM branches WHERE id IN (${group.map(() => "?").join(",")})`).bind(...group).all();
    for (const branch of branchRows.results) existingBranches.set(Number(branch.id), branch);
  }

  const credential = await hashPassword(requiredPassword(env.INITIAL_PASSWORD, "รหัสผ่านเริ่มต้นระบบ"));
  const statements = [];
  let inserted = 0; let updated = 0; let reactivated = 0;
  const branches = [...unique.values()];
  for (const branch of branches) {
    const current = existingBranches.get(branch.id);
    if (!current) inserted += 1;
    else if (Number(current.active) === 1) updated += 1;
    else reactivated += 1;
  }
  for (const group of chunk(branches, 50)) {
    const values = group.map(() => "(?, ?, 1, 'ACTIVE')").join(", ");
    const bindings = group.flatMap((branch) => [branch.id, branch.name]);
    statements.push(env.DB.prepare(`INSERT INTO branches (id, name, active, status) VALUES ${values} ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1, status = 'ACTIVE'`).bind(...bindings));
  }
  for (const group of chunk(branches, 12)) {
    const values = group.map(() => "(?, ?, ?, 'BRANCH', ?, ?, ?, 1)").join(", ");
    const bindings = group.flatMap((branch) => [crypto.randomUUID(), `JIB${branch.id}`, branch.name, branch.id, credential.salt, credential.hash]);
    statements.push(env.DB.prepare(`INSERT INTO users (id, username, display_name, role, branch_id, password_salt, password_hash, must_change_password) VALUES ${values} ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, branch_id = excluded.branch_id, active = 1`).bind(...bindings));
  }
  for (const group of chunk(statements, 80)) await env.DB.batch(group);
  await audit(env, user, "IMPORT", "BRANCH", "batch", { inserted, updated, reactivated });
  return json({ inserted, updated, reactivated, total: unique.size });
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
  const used = await env.DB.prepare(`SELECT 1 FROM order_items WHERE part_id = ?
    UNION ALL SELECT 1 FROM demand_items WHERE part_id = ? LIMIT 1`).bind(id, id).first();
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

async function catalog(env) {
  const { results } = await env.DB.prepare("SELECT id, name, sell_price FROM parts WHERE status = 'OPEN' ORDER BY name, id").all();
  return json({ items: results });
}

async function createOrder(request, env, user) {
  requireBranch(user);
  const body = await bodyJson(request);
  const customerName = cleanText(body.customerName, 200); const note = cleanText(body.note, 500);
  if (!customerName) throw new AppError(400, "กรอกชื่อลูกค้า");
  if (!Array.isArray(body.items) || body.items.length === 0) throw new AppError(400, "เลือกสินค้าอย่างน้อย 1 รายการ");
  const ids = [...new Set(body.items.map((item) => cleanText(item.partId, 100).toUpperCase()))];
  if (ids.length !== body.items.length || ids.some((id) => !id)) throw new AppError(400, "รายการสินค้าไม่ถูกต้อง");
  const products = await env.DB.prepare(`SELECT id, name, sell_price FROM parts WHERE status = 'OPEN' AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  if (products.results.length !== ids.length) throw new AppError(409, "มีสินค้าที่ปิดรับแจ้งความต้องการ");
  const byId = new Map(products.results.map((part) => [part.id, part]));
  const orderId = `REQ-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const statements = [env.DB.prepare("INSERT INTO demand_requests (id, branch_id, customer_name, note) VALUES (?, ?, ?, ?)").bind(orderId, user.branch_id, customerName, note || null)];
  for (const item of body.items) {
    const quantity = Number(item.quantity); const part = byId.get(cleanText(item.partId, 100).toUpperCase());
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new AppError(400, "จำนวนที่ต้องการไม่ถูกต้อง");
    statements.push(env.DB.prepare("INSERT INTO demand_items (id, request_id, part_id, part_name_snapshot, sell_price_snapshot, requested_quantity) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), orderId, part.id, part.name, part.sell_price, quantity));
  }
  await env.DB.batch(statements);
  await audit(env, user, "CREATE", "DEMAND", orderId, { customerName, items: body.items.length });
  return json({ orderId }, 201);
}

async function listOrders(env, user) {
  const conditions = user.role === "BRANCH" ? "WHERE d.branch_id = ?" : "";
  const statement = env.DB.prepare(`SELECT d.*, b.name AS branch_name,
    di.id AS item_id, di.part_id, di.part_name_snapshot, di.requested_quantity, di.allocated_quantity
    FROM demand_requests d JOIN branches b ON b.id = d.branch_id JOIN demand_items di ON di.request_id = d.id
    ${conditions} ORDER BY d.created_at DESC, d.id, di.part_name_snapshot`);
  const { results } = user.role === "BRANCH" ? await statement.bind(user.branch_id).all() : await statement.all();
  const orders = []; const byId = new Map();
  for (const row of results) {
    let order = byId.get(row.id);
    if (!order) {
      order = { id: row.id, branch_id: row.branch_id, branch_name: row.branch_name, customer_name: row.customer_name,
        status: row.status, note: row.note, admin_note: row.admin_note, created_at: row.created_at,
        allocated_at: row.allocated_at, sent_at: row.sent_at, requested_total: 0, allocated_total: 0, items: [] };
      byId.set(row.id, order); orders.push(order);
    }
    const item = { id: row.item_id, part_id: row.part_id, part_name_snapshot: row.part_name_snapshot,
      requested_quantity: Number(row.requested_quantity), allocated_quantity: Number(row.allocated_quantity) };
    order.items.push(item); order.requested_total += item.requested_quantity; order.allocated_total += item.allocated_quantity;
  }
  for (const order of orders) order.item_summary = order.items.map((item) => `${item.part_name_snapshot} ×${item.requested_quantity}`).join(", ");
  return json({ orders });
}

async function getOrder(env, user, orderId) {
  requireBranch(user);
  const order = await env.DB.prepare("SELECT d.*, b.name AS branch_name FROM demand_requests d JOIN branches b ON b.id = d.branch_id WHERE d.id = ? AND d.branch_id = ?").bind(orderId, user.branch_id).first();
  if (!order) throw new AppError(404, "ไม่พบรายการความต้องการ");
  const { results: items } = await env.DB.prepare("SELECT id, part_id, part_name_snapshot, sell_price_snapshot, requested_quantity, allocated_quantity FROM demand_items WHERE request_id = ? ORDER BY part_name_snapshot").bind(orderId).all();
  return json({ order, items });
}

async function updateOrder(request, env, user, orderId) {
  requireBranch(user);
  const order = await env.DB.prepare("SELECT id, status FROM demand_requests WHERE id = ? AND branch_id = ?").bind(orderId, user.branch_id).first();
  if (!order) throw new AppError(404, "ไม่พบรายการความต้องการ");
  if (order.status !== "PENDING") throw new AppError(409, "แก้ไขได้เฉพาะรายการที่รอจัดสรร");
  const body = await bodyJson(request); const customerName = cleanText(body.customerName, 200); const note = cleanText(body.note, 500);
  if (!customerName || !Array.isArray(body.items) || body.items.length === 0) throw new AppError(400, "ข้อมูลรายการไม่ครบถ้วน");
  const source = await env.DB.prepare("SELECT id FROM demand_items WHERE request_id = ?").bind(orderId).all();
  const allowed = new Set(source.results.map((item) => item.id)); const received = new Set(); const statements = [];
  for (const item of body.items) {
    const quantity = Number(item.quantity);
    if (!allowed.has(item.itemId) || received.has(item.itemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new AppError(400, "จำนวนที่ต้องการไม่ถูกต้อง");
    received.add(item.itemId);
    statements.push(env.DB.prepare("UPDATE demand_items SET requested_quantity = ? WHERE id = ? AND request_id = ?").bind(quantity, item.itemId, orderId));
  }
  if (body.items.length !== allowed.size) throw new AppError(400, "รายการสินค้าไม่ครบถ้วน");
  statements.push(env.DB.prepare("UPDATE demand_requests SET customer_name = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(customerName, note || null, orderId));
  await env.DB.batch(statements);
  await audit(env, user, "UPDATE", "DEMAND", orderId, { customerName });
  return json({ ok: true });
}

async function deleteBranchOrder(env, user, orderId) {
  requireBranch(user);
  const order = await env.DB.prepare("SELECT id, branch_id, customer_name, status FROM demand_requests WHERE id = ? AND branch_id = ?").bind(orderId, user.branch_id).first();
  if (!order) throw new AppError(404, "ไม่พบรายการความต้องการ");
  if (order.status !== "PENDING") throw new AppError(409, "ลบได้เฉพาะรายการที่รอจัดสรร");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM demand_items WHERE request_id = ?").bind(orderId),
    env.DB.prepare("DELETE FROM demand_requests WHERE id = ? AND branch_id = ?").bind(orderId, user.branch_id),
  ]);
  await audit(env, user, "DELETE", "DEMAND", orderId, { by: "BRANCH", branchId: order.branch_id, customerName: order.customer_name, status: order.status });
  return json({ deleted: true });
}

async function listAdminOrders(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare(`SELECT d.*, b.name AS branch_name,
    SUM(di.requested_quantity) AS requested_total, SUM(di.allocated_quantity) AS allocated_total,
    GROUP_CONCAT(di.part_name_snapshot || ' ×' || di.requested_quantity, ', ') AS item_summary
    FROM demand_requests d JOIN branches b ON b.id = d.branch_id JOIN demand_items di ON di.request_id = d.id
    GROUP BY d.id ORDER BY CASE d.status WHEN 'PENDING' THEN 0 WHEN 'PARTIAL' THEN 1 WHEN 'ALLOCATED' THEN 2 ELSE 3 END, d.created_at ASC`).all();
  return json({ orders: results });
}

async function listAdminExportRows(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare(`SELECT d.id AS request_id, d.created_at, d.customer_name, d.status,
    d.note, d.admin_note, d.allocated_at, d.sent_at, d.branch_id, b.name AS branch_name,
    di.part_id, di.part_name_snapshot, di.sell_price_snapshot, di.requested_quantity, di.allocated_quantity,
    au.display_name AS allocated_by_name, su.display_name AS sent_by_name
    FROM demand_requests d JOIN branches b ON b.id = d.branch_id
    JOIN demand_items di ON di.request_id = d.id
    LEFT JOIN users au ON au.id = d.allocated_by LEFT JOIN users su ON su.id = d.sent_by
    ORDER BY d.created_at DESC, d.id, di.part_name_snapshot`).all();
  return json({ rows: results });
}

async function getAdminOrder(env, user, orderId) {
  requireAdmin(user);
  const order = await env.DB.prepare(`SELECT d.*, b.name AS branch_name, au.display_name AS allocated_by_name, su.display_name AS sent_by_name
    FROM demand_requests d JOIN branches b ON b.id = d.branch_id
    LEFT JOIN users au ON au.id = d.allocated_by LEFT JOIN users su ON su.id = d.sent_by WHERE d.id = ?`).bind(orderId).first();
  if (!order) throw new AppError(404, "ไม่พบรายการความต้องการ");
  const { results: items } = await env.DB.prepare("SELECT id, part_id, part_name_snapshot, sell_price_snapshot, requested_quantity, allocated_quantity, item_note FROM demand_items WHERE request_id = ? ORDER BY part_name_snapshot").bind(orderId).all();
  return json({ order, items });
}

async function deleteAdminOrder(env, user, orderId) {
  requireAdmin(user);
  const order = await env.DB.prepare(`SELECT d.id, d.branch_id, d.customer_name, d.status, COUNT(di.id) AS item_count
    FROM demand_requests d LEFT JOIN demand_items di ON di.request_id = d.id
    WHERE d.id = ? GROUP BY d.id`).bind(orderId).first();
  if (!order) throw new AppError(404, "ไม่พบรายการความต้องการ");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM demand_items WHERE request_id = ?").bind(orderId),
    env.DB.prepare("DELETE FROM demand_requests WHERE id = ?").bind(orderId),
  ]);
  await audit(env, user, "DELETE", "DEMAND", orderId, { by: "ADMIN", branchId: order.branch_id, customerName: order.customer_name, status: order.status, itemCount: Number(order.item_count) });
  return json({ deleted: true });
}

async function allocateOrder(request, env, user, orderId) {
  requireAdmin(user);
  const body = await bodyJson(request);
  if (!Array.isArray(body.items) || body.items.length === 0) throw new AppError(400, "ต้องระบุจำนวนจัดสรร");
  const order = await env.DB.prepare("SELECT id, status FROM demand_requests WHERE id = ?").bind(orderId).first();
  if (!order) throw new AppError(404, "ไม่พบรายการความต้องการ");
  if (["SENT", "CANCELLED"].includes(order.status)) throw new AppError(409, "รายการนี้ปิดดำเนินการแล้ว");
  const source = await env.DB.prepare("SELECT id, requested_quantity FROM demand_items WHERE request_id = ?").bind(orderId).all();
  const allowed = new Map(source.results.map((row) => [row.id, row.requested_quantity]));
  const received = new Set(); const statements = []; let requestedTotal = 0; let allocatedTotal = 0;
  for (const item of body.items) {
    const quantity = Number(item.allocatedQuantity);
    if (!allowed.has(item.itemId) || received.has(item.itemId) || !Number.isInteger(quantity) || quantity < 0 || quantity > allowed.get(item.itemId)) throw new AppError(400, "จำนวนจัดสรรไม่ถูกต้อง");
    received.add(item.itemId);
    requestedTotal += Number(allowed.get(item.itemId)); allocatedTotal += quantity;
    statements.push(env.DB.prepare("UPDATE demand_items SET allocated_quantity = ?, item_note = ? WHERE id = ? AND request_id = ?").bind(quantity, cleanText(item.note, 300) || null, item.itemId, orderId));
  }
  if (body.items.length !== allowed.size) throw new AppError(400, "รายการจัดสรรไม่ครบถ้วน");
  const status = allocatedTotal === 0 ? "PENDING" : allocatedTotal < requestedTotal ? "PARTIAL" : "ALLOCATED";
  statements.push(env.DB.prepare("UPDATE demand_requests SET status = ?, admin_note = ?, allocated_at = CASE WHEN ? = 'PENDING' THEN NULL ELSE CURRENT_TIMESTAMP END, allocated_by = CASE WHEN ? = 'PENDING' THEN NULL ELSE ? END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, cleanText(body.adminNote, 500) || null, status, status, user.id, orderId));
  await env.DB.batch(statements);
  await audit(env, user, "ALLOCATE", "DEMAND", orderId, { status, requestedTotal, allocatedTotal });
  return json({ ok: true, status });
}

async function markOrderSent(env, user, orderId) {
  requireAdmin(user);
  const result = await env.DB.prepare("UPDATE demand_requests SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, sent_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('PARTIAL', 'ALLOCATED')").bind(user.id, orderId).run();
  if (!result.meta.changes) throw new AppError(409, "ต้องจัดสรรสินค้าก่อนบันทึกว่าส่งแล้ว");
  await audit(env, user, "SEND", "DEMAND", orderId, null);
  return json({ sent: true });
}

async function summary(env, user) {
  requireAdmin(user);
  const [orders, pending, allocated, branches] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS value FROM demand_requests"),
    env.DB.prepare("SELECT COUNT(*) AS value FROM demand_requests WHERE status = 'PENDING'"),
    env.DB.prepare("SELECT COUNT(*) AS value FROM demand_requests WHERE status IN ('PARTIAL', 'ALLOCATED')"),
    env.DB.prepare("SELECT COUNT(DISTINCT branch_id) AS value FROM demand_requests"),
  ]);
  return json({ totalOrders: Number(orders.results[0].value), pendingOrders: Number(pending.results[0].value), allocatedOrders: Number(allocated.results[0].value), participatingBranches: Number(branches.results[0].value) });
}

function partInput(value) {
  const id = cleanText(value.id, 100).toUpperCase(); const name = cleanText(value.name, 300); const sellPrice = Number(value.sellPrice);
  const status = ["OPEN", "PAUSED", "INACTIVE"].includes(value.status) ? value.status : "OPEN";
  if (!id || !name || !Number.isInteger(sellPrice) || sellPrice < 0) throw new AppError(400, "ข้อมูล Part ไม่ถูกต้อง");
  return { id, name, sellPrice, status };
}

function branchInput(value) {
  const id = Number(value.id); const name = cleanText(value.name, 200);
  if (!Number.isSafeInteger(id) || id < 1 || id > 99999 || !name) throw new AppError(400, "ข้อมูลสาขาไม่ถูกต้อง");
  return { id, name };
}

function chunk(values, size) { const groups = []; for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size)); return groups; }

function userInsertStatement(env, username, displayName, role, branchId, credential, mustChangePassword = false) {
  return env.DB.prepare("INSERT INTO users (id, username, display_name, role, branch_id, password_salt, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), username, displayName, role, branchId, credential.salt, credential.hash, mustChangePassword ? 1 : 0);
}

async function createLoginResponse(request, env, user) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 1000).toISOString();
  const access = clientAccess(request);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, ip_address, country, province, district, network_asn, network_isp, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").bind(await sha256(token), user.id, expiresAt, access.ipAddress, access.country, access.province, access.district, access.networkAsn, access.networkIsp, access.userAgent).run();
  await audit(env, user, "LOGIN", "USER", user.id, null);
  return json({ user: publicUser(user) }, 200, { "set-cookie": sessionCookie(token, new URL(request.url).protocol === "https:") });
}

async function audit(env, user, action, entityType, entityId, detail) {
  await env.DB.prepare("INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user?.id || null, action, entityType, entityId, detail ? JSON.stringify(detail) : null).run();
}

function publicUser(user) { return { id: user.id, username: user.username, displayName: user.display_name, role: user.role, branchId: user.branch_id, branchName: user.branch_name, mustChangePassword: Boolean(user.must_change_password) }; }
function requireAdmin(user) { if (user.role !== "ADMIN") throw new AppError(403, "เฉพาะผู้ดูแลระบบเท่านั้น"); }
function requireBranch(user) { if (user.role !== "BRANCH") throw new AppError(403, "เฉพาะบัญชีสาขาเท่านั้น"); }
function requiredPassword(value, label) { const password = String(value || ""); if (password.length < 4) throw new AppError(400, `${label}ต้องมีอย่างน้อย 4 ตัวอักษร`); return password; }
function cleanText(value, max) { return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : ""; }
async function bodyJson(request) { const length = Number(request.headers.get("content-length") || 0); if (length > 1_000_000) throw new AppError(413, "ข้อมูลมีขนาดใหญ่เกินไป"); try { return await request.json(); } catch { throw new AppError(400, "รูปแบบข้อมูลไม่ถูกต้อง"); } }
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } }); }
function cookie(request, name) { return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
function clientAccess(request) { const cf = request.cf || {}; const networkAsn = Number(cf.asn); return { ipAddress: cleanText(request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for")?.split(",")[0], 80) || null, country: cleanText(cf.country || request.headers.get("CF-IPCountry"), 8) || null, province: cleanText(cf.region || cf.regionCode, 120) || null, district: cleanText(cf.city, 120) || null, networkAsn: Number.isSafeInteger(networkAsn) && networkAsn > 0 ? networkAsn : null, networkIsp: cleanText(cf.asOrganization, 200) || null, userAgent: cleanText(request.headers.get("user-agent"), 500) || null }; }
function sessionCookie(token, secure) { return `jib_session=${token}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${SESSION_DAYS}`; }
function expireCookie() { return "jib_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }
function corsHeaders(request) { const origin = request.headers.get("origin"); return origin && origin === new URL(request.url).origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", vary: "origin" } : {}; }
function withCors(response, request) { const headers = new Headers(response.headers); for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value); return new Response(response.body, { status: response.status, headers }); }
async function hashPassword(password, suppliedSalt) { const salt = suppliedSalt || randomBase64(16); const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]); const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(salt), iterations: 100000 }, key, 256); return { salt, hash: toBase64(new Uint8Array(bits)) }; }
async function verifyPassword(password, salt, hash) { const candidate = await hashPassword(password, salt); return timingSafeEqual(fromBase64(candidate.hash), fromBase64(hash)); }
async function sha256(value) { return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
function randomBase64(bytes) { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return toBase64(value); }
function toBase64(value) { return btoa(String.fromCharCode(...value)); }
function fromBase64(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function timingSafeEqual(left, right) { if (left.length !== right.length) return false; let result = 0; for (let index = 0; index < left.length; index += 1) result |= left[index] ^ right[index]; return result === 0; }
class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
