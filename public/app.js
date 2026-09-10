const app = document.querySelector("#app");
const state = { user: null, page: null, cart: new Map(), catalog: [], parts: [], rounds: [], orders: [] };

const money = new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" });

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) }, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "ไม่สามารถดำเนินการได้");
  return data;
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function fmtDate(value) { return value ? date.format(new Date(value)) : "–"; }
function statusLabel(status) { return ({ OPEN: "เปิดรับจอง", PAUSED: "ปิดชั่วคราว", INACTIVE: "เลิกใช้งาน", DRAFT: "ร่าง", CLOSED: "ปิดรอบแล้ว", PENDING: "รอพิจารณา", ALLOCATED: "จัดสรรแล้ว", PREPARING: "เตรียมส่ง", SHIPPED: "ส่งแล้ว", RECEIVED: "รับสินค้าแล้ว", REJECTED: "ไม่อนุมัติ", CANCELLED: "ยกเลิก" })[status] || status; }
function badge(status) { return `<span class="badge ${String(status).toLowerCase()}">${statusLabel(status)}</span>`; }
function flash(message, isError = false) { return `<div class="flash ${isError ? "error" : ""}">${escapeHtml(message)}</div>`; }
function showMessage(message, isError = false) { const target = document.querySelector("[data-flash]"); if (target) target.innerHTML = flash(message, isError); else alert(message); }

function authShell(content) { return `<div class="auth"><aside class="brand-panel"><div><div class="brand">JIB<small>PRE-ORDER PORTAL</small></div></div><p class="brand-note">ระบบจองสินค้าสำหรับสาขา ติดตามสถานะได้ด้วยบัญชีของสาขา และจัดการสินค้า รอบจอง และการจัดสรรจากส่วนกลาง</p></aside><section class="auth-body">${content}</section></div>`; }

function renderSetup() {
  app.innerHTML = authShell(`<section class="card"><h1>ตั้งค่าระบบครั้งแรก</h1><p class="muted">กำหนดรหัสผ่านผู้ดูแลและรหัสผ่านเริ่มต้นสำหรับบัญชีสาขาทั้ง 22 สาขา</p><div data-flash></div><form class="form" id="setup-form"><label class="field">รหัสตั้งค่าระบบ<input name="setupToken" type="password" required autocomplete="one-time-code" /></label><label class="field">ชื่อผู้ดูแล<input name="adminName" required maxlength="100" value="ผู้ดูแลระบบ" /></label><label class="field">รหัสผ่านผู้ดูแล (อย่างน้อย 4 ตัวอักษร)<input name="adminPassword" type="password" minlength="4" required autocomplete="new-password" /></label><label class="field">รหัสผ่านเริ่มต้นสาขา (อย่างน้อย 4 ตัวอักษร)<input name="branchPassword" type="password" minlength="4" required autocomplete="new-password" /></label><button class="btn btn-primary" type="submit">ตั้งค่าระบบและเข้าสู่หลังบ้าน</button></form><p class="setup-help">บัญชีสาขาจะเป็น <b>BR284, BR286, …</b> ตามรหัสสาขาในไฟล์ Branch.xlsx ควรเปลี่ยนรหัสผ่านของสาขาหลังเริ่มใช้งานจริง</p></section>`);
  document.querySelector("#setup-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const result = await api("/api/setup", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); state.user = result.user; state.page = "dashboard"; await renderApp(); } catch (error) { showMessage(error.message, true); } });
}

function renderLogin() {
  app.innerHTML = authShell(`<section class="card"><h1>เข้าสู่ระบบจองสินค้า</h1><p class="muted">ใช้บัญชีที่ส่วนกลางกำหนดให้สำหรับสาขาของคุณ</p><div data-flash></div><form class="form" id="login-form"><label class="field">ชื่อผู้ใช้งาน<input name="username" required autocomplete="username" placeholder="BR284 หรือ ADMIN" /></label><label class="field">รหัสผ่าน<input name="password" type="password" required autocomplete="current-password" /></label><button class="btn btn-primary" type="submit">เข้าสู่ระบบ</button></form></section>`);
  document.querySelector("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const result = await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); state.user = result.user; state.page = state.user.role === "ADMIN" ? "dashboard" : "catalog"; await renderApp(); } catch (error) { showMessage(error.message, true); } });
}

function shell(content) {
  const isAdmin = state.user.role === "ADMIN";
  const nav = isAdmin ? [["dashboard", "ภาพรวม"], ["parts", "จัดการ Part"], ["rounds", "รอบจอง"], ["admin-orders", "ใบจองและจัดสรร"], ["import", "นำเข้า Excel"]] : [["catalog", "เลือกสินค้า"], ["orders", "รายการจองของฉัน"]];
  return `<div class="shell"><aside class="sidebar"><div class="brand">JIB<small>PRE-ORDER PORTAL</small></div><nav class="nav">${nav.map(([id, label]) => `<button class="${state.page === id ? "active" : ""}" data-page="${id}">${label}</button>`).join("")}</nav><div class="sidebar-foot">${isAdmin ? "ผู้ดูแลระบบส่วนกลาง" : `สาขา ${state.user.branchId}<br>${escapeHtml(state.user.branchName)}`}</div></aside><main class="main"><div class="topbar"><span class="context">${isAdmin ? "WORKSPACE / ส่วนกลาง" : `สาขา ${state.user.branchId} / ${escapeHtml(state.user.branchName)}`}</span><button class="btn btn-outline btn-small" id="logout">ออกจากระบบ</button></div><div data-flash></div>${content}</main></div>`;
}

async function renderApp() {
  if (!state.user) return boot();
  const pages = { dashboard: renderDashboard, parts: renderParts, rounds: renderRounds, "admin-orders": renderAdminOrders, import: renderImport, catalog: renderCatalog, orders: renderOrders };
  const renderer = pages[state.page] || (state.user.role === "ADMIN" ? renderDashboard : renderCatalog);
  await renderer();
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", async () => { state.page = button.dataset.page; await renderApp(); }));
  document.querySelector("#logout")?.addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); state.user = null; state.cart.clear(); await boot(); });
}

async function renderDashboard() {
  const summary = await api("/api/admin/summary");
  app.innerHTML = shell(`<section class="page-header"><div><h1>ภาพรวมการจอง</h1><p>ติดตามงานที่ต้องดำเนินการจากส่วนกลาง</p></div><button class="btn btn-primary" data-page="admin-orders">ดูใบจองที่รอพิจารณา</button></section><section class="grid grid-3"><article class="stat"><label>ใบจองทั้งหมด</label><strong>${summary.totalOrders}</strong></article><article class="stat"><label>รอพิจารณา</label><strong>${summary.pendingOrders}</strong></article><article class="stat"><label>จัดสรรแล้ว</label><strong>${summary.allocatedOrders}</strong></article></section><section class="panel" style="margin-top:18px"><h2>การมีส่วนร่วมของสาขา</h2><p class="muted">มีสาขาส่งคำขอแล้ว ${summary.participatingBranches} จาก 22 สาขา</p><button class="btn btn-primary" data-page="rounds">จัดการรอบจอง</button></section>`);
}

async function renderParts() {
  const { parts } = await api("/api/parts"); state.parts = parts;
  app.innerHTML = shell(`<section class="page-header"><div><h1>จัดการ Part สินค้า</h1><p>เพิ่ม แก้ไข ปิดชั่วคราว หรือเลิกใช้งานสินค้า</p></div><button class="btn btn-primary" id="add-part">+ เพิ่ม Part</button></section><section class="toolbar"><label class="field">ค้นหา<input id="part-search" placeholder="รหัส Part หรือชื่อสินค้า" /></label><label class="field compact">สถานะ<select id="part-status"><option value="">ทั้งหมด</option><option value="OPEN">เปิดรับจอง</option><option value="PAUSED">ปิดชั่วคราว</option><option value="INACTIVE">เลิกใช้งาน</option></select></label><button class="btn btn-outline" data-page="import">นำเข้า Excel</button></section><section class="table-wrap"><table class="table"><thead><tr><th>สินค้า / Part</th><th>ราคาขาย</th><th>สถานะ</th><th>จัดการ</th></tr></thead><tbody id="parts-body"></tbody></table></section>`);
  const draw = () => { const search = document.querySelector("#part-search").value.toLowerCase(); const status = document.querySelector("#part-status").value; const rows = state.parts.filter((part) => (!status || part.status === status) && `${part.id} ${part.name}`.toLowerCase().includes(search)); document.querySelector("#parts-body").innerHTML = rows.length ? rows.map((part) => `<tr><td><b>${escapeHtml(part.name)}</b><span class="part">${escapeHtml(part.id)}</span></td><td>${money.format(part.sell_price)}</td><td>${badge(part.status)}</td><td><button class="btn btn-outline btn-small" data-edit-part="${escapeHtml(part.id)}">แก้ไข</button></td></tr>`).join("") : `<tr><td colspan="4" class="empty">ไม่พบ Part</td></tr>`; document.querySelectorAll("[data-edit-part]").forEach((button) => button.addEventListener("click", () => partDialog(state.parts.find((part) => part.id === button.dataset.editPart)))); };
  draw(); document.querySelector("#part-search").addEventListener("input", draw); document.querySelector("#part-status").addEventListener("change", draw); document.querySelector("#add-part").addEventListener("click", () => partDialog());
}

function partDialog(part) {
  const existing = Boolean(part); const modal = document.createElement("div"); modal.className = "dialog-backdrop";
  modal.innerHTML = `<form class="dialog form" id="part-form"><h2>${existing ? "แก้ไข Part สินค้า" : "เพิ่ม Part สินค้า"}</h2><label class="field">รหัส Part *<input name="id" ${existing ? "readonly" : ""} value="${escapeHtml(part?.id || "")}" required /></label><label class="field">ชื่อสินค้า *<input name="name" value="${escapeHtml(part?.name || "")}" required /></label><label class="field">ราคาขาย (บาท) *<input name="sellPrice" type="number" min="0" step="1" value="${part?.sell_price ?? ""}" required /></label><label class="field">สถานะ<select name="status">${["OPEN", "PAUSED", "INACTIVE"].map((status) => `<option value="${status}" ${part?.status === status ? "selected" : ""}>${statusLabel(status)}</option>`).join("")}</select></label><p class="muted">การแก้ชื่อหรือราคาจะไม่เปลี่ยนข้อมูลในใบจองเดิม</p><div class="dialog-footer">${existing ? `<button class="btn btn-danger" type="button" id="remove-part">${part.status === "INACTIVE" ? "ลบ Part" : "เลิกใช้งาน / ลบ"}</button>` : ""}<button class="btn btn-outline" type="button" data-close>ยกเลิก</button><button class="btn btn-primary" type="submit">บันทึก</button></div></form>`;
  document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("#part-form").addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); data.sellPrice = Number(data.sellPrice); try { await api(existing ? `/api/parts/${encodeURIComponent(part.id)}` : "/api/parts", { method: existing ? "PATCH" : "POST", body: JSON.stringify(data) }); modal.remove(); await renderParts(); } catch (error) { showMessage(error.message, true); } });
  modal.querySelector("#remove-part")?.addEventListener("click", async () => { if (!confirm("ยืนยันการเลิกใช้งานหรือลบ Part นี้?")) return; try { const result = await api(`/api/parts/${encodeURIComponent(part.id)}`, { method: "DELETE" }); modal.remove(); await renderParts(); showMessage(result.inactivated ? "Part มีประวัติการจอง จึงเปลี่ยนเป็นเลิกใช้งานแล้ว" : "ลบ Part แล้ว"); } catch (error) { showMessage(error.message, true); } });
}

async function renderImport() {
  app.innerHTML = shell(`<section class="page-header"><div><h1>นำเข้าสินค้าจาก Excel</h1><p>รองรับคอลัมน์ Product, Product Name และ Sell Price</p></div></section><section class="panel"><h2>เลือกไฟล์ pre order.xlsx</h2><p class="muted">ระบบตรวจรหัส Part ซ้ำ ข้อมูลว่าง และราคาที่ไม่ถูกต้องก่อนบันทึก</p><input id="xlsx-file" type="file" accept=".xlsx,.xls" /><div id="import-preview" class="empty">ยังไม่ได้เลือกไฟล์</div></section>`);
  document.querySelector("#xlsx-file").addEventListener("change", async (event) => { const file = event.target.files[0]; if (!file) return; if (!window.XLSX) return showMessage("กำลังโหลดตัวอ่าน Excel กรุณาลองอีกครั้ง", true); try { const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" }); const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" }); renderImportPreview(rows); } catch { showMessage("ไม่สามารถอ่านไฟล์ Excel ได้", true); } });
}

function renderImportPreview(rows) {
  const preview = document.querySelector("#import-preview"); const sample = rows.slice(0, 5); preview.className = "";
  preview.innerHTML = `<div class="notice"><b>พบ ${rows.length} รายการ</b><br>ตรวจสอบตัวอย่างก่อนยืนยันนำเข้า</div><div class="table-wrap" style="margin-top:14px"><table class="table"><thead><tr><th>Product</th><th>Product Name</th><th>Sell Price</th></tr></thead><tbody>${sample.map((row) => `<tr><td>${escapeHtml(row.Product)}</td><td>${escapeHtml(row["Product Name"])}</td><td>${escapeHtml(row["Sell Price"])}</td></tr>`).join("")}</tbody></table></div><button class="btn btn-primary" id="confirm-import" style="margin-top:14px">ยืนยันนำเข้า</button>`;
  preview.querySelector("#confirm-import").onclick = async () => { try { const result = await api("/api/parts/import", { method: "POST", body: JSON.stringify({ rows }) }); showMessage(`นำเข้าสำเร็จ: เพิ่มใหม่ ${result.inserted} รายการ, อัปเดต ${result.updated} รายการ`); preview.querySelector("#confirm-import").disabled = true; } catch (error) { showMessage(error.message, true); } };
}

async function renderRounds() {
  const [{ rounds }, { parts }] = await Promise.all([api("/api/rounds"), api("/api/parts")]); state.rounds = rounds; state.parts = parts;
  app.innerHTML = shell(`<section class="page-header"><div><h1>รอบจองสินค้า</h1><p>กำหนดเวลาเปิดรับสินค้าและโควตา</p></div><button class="btn btn-primary" id="add-round">+ สร้างรอบจอง</button></section><section class="table-wrap"><table class="table"><thead><tr><th>รอบจอง</th><th>ช่วงเปิดรับ</th><th>สินค้า</th><th>สถานะ</th><th></th></tr></thead><tbody>${rounds.length ? rounds.map((round) => `<tr><td><b>${escapeHtml(round.name)}</b></td><td>${fmtDate(round.opens_at)}<br>ถึง ${fmtDate(round.closes_at)}</td><td>${round.part_count} Part</td><td>${badge(round.status)}</td><td><button class="btn btn-outline btn-small" data-edit-round="${round.id}">จัดการ</button></td></tr>`).join("") : `<tr><td colspan="5" class="empty">ยังไม่มีรอบจอง</td></tr>`}</tbody></table></section>`);
  document.querySelector("#add-round").onclick = () => roundDialog(); document.querySelectorAll("[data-edit-round]").forEach((button) => button.onclick = () => roundDialog(state.rounds.find((round) => round.id === button.dataset.editRound)));
}

async function roundDialog(round) {
  let selectedParts = [];
  if (round) selectedParts = (await api(`/api/rounds/${round.id}/parts`)).parts.map((item) => item.part_id);
  const modal = document.createElement("div"); const existing = Boolean(round); modal.className = "dialog-backdrop";
  modal.innerHTML = `<form class="dialog form" id="round-form"><h2>${existing ? "จัดการรอบจอง" : "สร้างรอบจอง"}</h2><label class="field">ชื่อรอบ<input name="name" required value="${escapeHtml(round?.name || "")}" placeholder="เช่น PRE-ORDER 01" /></label><label class="field">เริ่มเปิดรับ<input name="opensAt" type="datetime-local" required value="${toLocalInput(round?.opens_at)}" /></label><label class="field">ปิดรับ<input name="closesAt" type="datetime-local" required value="${toLocalInput(round?.closes_at)}" /></label><label class="field">สถานะ<select name="status">${["DRAFT", "OPEN", "CLOSED"].map((status) => `<option value="${status}" ${round?.status === status ? "selected" : ""}>${statusLabel(status)}</option>`).join("")}</select></label><label class="field">Part ในรอบ (เลือกได้หลายรายการ)<select name="parts" multiple size="7">${state.parts.filter((part) => part.status === "OPEN").map((part) => `<option value="${escapeHtml(part.id)}" ${selectedParts.includes(part.id) ? "selected" : ""}>${escapeHtml(part.id)} — ${escapeHtml(part.name)}</option>`).join("")}</select></label><p class="muted">โควตาเริ่มต้นเป็นแบบไม่จำกัด สามารถเพิ่มการกำหนดโควตาราย Part ได้ในรุ่นถัดไป</p><div class="dialog-footer"><button type="button" class="btn btn-outline" data-close>ยกเลิก</button><button type="submit" class="btn btn-primary">บันทึก</button></div></form>`;
  document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("#round-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const data = Object.fromEntries(form); const parts = form.getAll("parts").map((partId) => ({ partId, quota: null })); try { const result = await api(existing ? `/api/rounds/${round.id}` : "/api/rounds", { method: existing ? "PATCH" : "POST", body: JSON.stringify(data) }); await api(`/api/rounds/${existing ? round.id : result.round.id}/parts`, { method: "PUT", body: JSON.stringify({ parts }) }); modal.remove(); await renderRounds(); } catch (error) { showMessage(error.message, true); } };
}

async function renderCatalog() {
  const { items } = await api("/api/catalog"); state.catalog = items;
  app.innerHTML = shell(`<section class="page-header"><div><h1>สินค้าที่เปิดรับจอง</h1><p>เลือกสินค้าและจำนวนก่อนส่งคำขอ</p></div><button class="btn btn-outline" data-page="orders">รายการจองของฉัน</button></section><section class="toolbar"><label class="field">ค้นหาสินค้า<input id="catalog-search" placeholder="รหัส Part หรือชื่อสินค้า" /></label></section><section class="table-wrap"><table class="table"><thead><tr><th>สินค้า / Part</th><th>รอบจอง</th><th>ราคาต่อชิ้น</th><th>จำนวน</th></tr></thead><tbody id="catalog-body"></tbody></table></section><section class="cart" id="cart"></section>`);
  const draw = () => { const search = document.querySelector("#catalog-search").value.toLowerCase(); const rows = items.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(search)); document.querySelector("#catalog-body").innerHTML = rows.length ? rows.map((item) => { const qty = state.cart.get(item.id)?.quantity || 0; return `<tr><td><b>${escapeHtml(item.name)}</b><span class="part">${escapeHtml(item.id)}</span></td><td>${escapeHtml(item.round_name)}</td><td>${money.format(item.sell_price)}</td><td><span class="qty"><button data-qty="-1" data-part="${escapeHtml(item.id)}">−</button><strong>${qty}</strong><button data-qty="1" data-part="${escapeHtml(item.id)}">+</button></span></td></tr>`; }).join("") : `<tr><td colspan="4" class="empty">ไม่มีสินค้าที่เปิดรับจอง</td></tr>`; document.querySelectorAll("[data-qty]").forEach((button) => button.onclick = () => changeCart(button.dataset.part, Number(button.dataset.qty))); drawCart(); };
  const drawCart = () => { const entries = [...state.cart.values()]; const total = entries.reduce((sum, item) => sum + item.quantity, 0); document.querySelector("#cart").innerHTML = total ? `<div><b>${entries.length} Part / ${total} ชิ้น</b><small>โปรดตรวจสอบก่อนยืนยัน</small></div><button class="btn btn-primary" id="checkout">ตรวจสอบใบจอง</button>` : `<div><b>ยังไม่ได้เลือกสินค้า</b><small>กด + เพื่อเพิ่มสินค้าลงใบจอง</small></div>`; document.querySelector("#checkout")?.addEventListener("click", checkoutDialog); };
  window.changeCart = (partId, delta) => { const item = items.find((entry) => entry.id === partId); const next = (state.cart.get(partId)?.quantity || 0) + delta; if (next <= 0) state.cart.delete(partId); else state.cart.set(partId, { ...item, quantity: next }); draw(); };
  draw(); document.querySelector("#catalog-search").addEventListener("input", draw);
}

function checkoutDialog() {
  const entries = [...state.cart.values()]; const rounds = new Set(entries.map((item) => item.round_id)); if (rounds.size !== 1) return showMessage("เลือกสินค้าได้ครั้งละหนึ่งรอบจอง", true);
  const modal = document.createElement("div"); modal.className = "dialog-backdrop"; const total = entries.reduce((sum, item) => sum + item.quantity * item.sell_price, 0);
  modal.innerHTML = `<form class="dialog form" id="checkout-form"><h2>ตรวจสอบใบจอง</h2><div class="table-wrap"><table class="table"><tbody>${entries.map((item) => `<tr><td><b>${escapeHtml(item.name)}</b><span class="part">${escapeHtml(item.id)}</span></td><td>${item.quantity} ชิ้น</td><td>${money.format(item.quantity * item.sell_price)}</td></tr>`).join("")}</tbody></table></div><p><b>รวม ${entries.reduce((sum, item) => sum + item.quantity, 0)} ชิ้น · ${money.format(total)}</b></p><label class="field">หมายเหตุถึงส่วนกลาง<textarea name="note" placeholder="ระบุหมายเหตุเพิ่มเติม (ถ้ามี)"></textarea></label><div class="dialog-footer"><button class="btn btn-outline" type="button" data-close>กลับไปแก้ไข</button><button class="btn btn-primary" type="submit">ยืนยันส่งคำขอ</button></div></form>`; document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("#checkout-form").onsubmit = async (event) => { event.preventDefault(); try { const { orderId } = await api("/api/orders", { method: "POST", body: JSON.stringify({ roundId: entries[0].round_id, note: new FormData(event.currentTarget).get("note"), items: entries.map((item) => ({ partId: item.id, quantity: item.quantity })) }) }); state.cart.clear(); state.page = "orders"; modal.remove(); await renderApp(); showMessage(`ส่งคำขอสำเร็จ: ${orderId}`); } catch (error) { showMessage(error.message, true); } };
}

async function renderOrders() {
  const { orders } = await api("/api/orders"); state.orders = orders;
  app.innerHTML = shell(`<section class="page-header"><div><h1>รายการจองของฉัน</h1><p>ติดตามการพิจารณาและการจัดสรรสินค้า</p></div><button class="btn btn-primary" data-page="catalog">สร้างใบจอง</button></section><section class="table-wrap"><table class="table"><thead><tr><th>เลขที่ใบจอง</th><th>รอบจอง</th><th>ขอ / จัดสรร</th><th>สถานะ</th><th>วันที่ส่ง</th></tr></thead><tbody>${orders.length ? orders.map((order) => `<tr><td><b>${escapeHtml(order.id)}</b></td><td>${escapeHtml(order.round_name)}</td><td>${order.requested_total} / ${order.status === "PENDING" ? "–" : order.allocated_total}</td><td>${badge(order.status)}</td><td>${fmtDate(order.created_at)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty">ยังไม่มีรายการจอง</td></tr>`}</tbody></table></section>`);
}

async function renderAdminOrders() {
  const { orders } = await api("/api/admin/orders");
  app.innerHTML = shell(`<section class="page-header"><div><h1>ใบจองและการจัดสรร</h1><p>พิจารณารายการที่สาขาส่งเข้ามา</p></div></section><section class="table-wrap"><table class="table"><thead><tr><th>เลขที่ใบจอง</th><th>สาขา</th><th>รอบจอง</th><th>ขอ / จัดสรร</th><th>สถานะ</th><th></th></tr></thead><tbody>${orders.length ? orders.map((order) => `<tr><td><b>${escapeHtml(order.id)}</b></td><td>${escapeHtml(order.branch_name)}</td><td>${escapeHtml(order.round_name)}</td><td>${order.requested_total} / ${order.status === "PENDING" ? "–" : order.allocated_total}</td><td>${badge(order.status)}</td><td><button class="btn btn-outline btn-small" data-allocate="${escapeHtml(order.id)}">${order.status === "PENDING" ? "พิจารณา" : "ดูการจัดสรร"}</button></td></tr>`).join("") : `<tr><td colspan="6" class="empty">ยังไม่มีใบจอง</td></tr>`}</tbody></table></section>`);
  document.querySelectorAll("[data-allocate]").forEach((button) => button.onclick = () => allocationDialog(button.dataset.allocate));
}

async function allocationDialog(orderId) {
  try {
    const { order, items } = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`); const modal = document.createElement("div"); modal.className = "dialog-backdrop";
    modal.innerHTML = `<form class="dialog form" id="allocation-form"><h2>พิจารณาใบจอง</h2><p class="muted"><b>${escapeHtml(order.id)}</b><br>${escapeHtml(order.branch_name)} · ${escapeHtml(order.round_name)}</p><div class="table-wrap"><table class="table"><thead><tr><th>Part</th><th>ขอจอง</th><th>จัดสรร</th></tr></thead><tbody>${items.map((item) => `<tr><td><b>${escapeHtml(item.part_name_snapshot)}</b><span class="part">${escapeHtml(item.part_id)}</span></td><td>${item.requested_quantity}</td><td><input data-item="${item.id}" type="number" min="0" max="${item.requested_quantity}" value="${item.allocated_quantity ?? item.requested_quantity}" /></td></tr>`).join("")}</tbody></table></div><label class="field">หมายเหตุถึงสาขา<textarea name="adminNote">${escapeHtml(order.admin_note || "")}</textarea></label><label class="field">ผลการพิจารณา<select name="status"><option value="ALLOCATED">จัดสรร</option><option value="REJECTED">ไม่อนุมัติทั้งใบ</option></select></label><div class="dialog-footer"><button class="btn btn-outline" data-close type="button">ยกเลิก</button><button class="btn btn-primary" type="submit">บันทึกการจัดสรร</button></div></form>`;
    document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
    modal.querySelector("#allocation-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const itemsPayload = [...modal.querySelectorAll("[data-item]")].map((input) => ({ itemId: input.dataset.item, allocatedQuantity: Number(input.value), note: "" })); try { await api(`/api/admin/orders/${encodeURIComponent(orderId)}/allocation`, { method: "PATCH", body: JSON.stringify({ items: itemsPayload, adminNote: form.get("adminNote"), status: form.get("status") }) }); modal.remove(); await renderAdminOrders(); showMessage("บันทึกการจัดสรรแล้ว"); } catch (error) { showMessage(error.message, true); } };
  } catch (error) { showMessage(error.message, true); }
}

function toLocalInput(value) { return value ? new Date(value).toISOString().slice(0, 16) : ""; }

async function boot() {
  try { const status = await api("/api/setup-status"); if (!status.ready) return renderSetup(); const { user } = await api("/api/me"); state.user = user; state.page = user.role === "ADMIN" ? "dashboard" : "catalog"; await renderApp(); } catch (error) { if (error.message.includes("เข้าสู่ระบบ") || error.message.includes("เซสชัน")) return renderLogin(); app.innerHTML = authShell(`<section class="card"><h1>ไม่สามารถเริ่มระบบได้</h1>${flash(error.message, true)}</section>`); } }

boot();
