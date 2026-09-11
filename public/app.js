const app = document.querySelector("#app");
const state = { user: null, page: null, cart: new Map(), catalog: [], parts: [], orders: [] };

const money = new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
const dateParts = new Intl.DateTimeFormat("en", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Bangkok" });

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) }, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "ไม่สามารถดำเนินการได้");
  return data;
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function timestamp(value) { if (!value) return null; const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value; return new Date(normalized); }
function fmtDate(value) { const parsed = timestamp(value); return parsed && !Number.isNaN(parsed.getTime()) ? date.format(parsed) : "–"; }
function bangkokDateKey(value) { const parsed = timestamp(value); if (!parsed || Number.isNaN(parsed.getTime())) return ""; const parts = Object.fromEntries(dateParts.formatToParts(parsed).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
function statusLabel(status) { return ({ OPEN: "เปิดรับแจ้งความต้องการ", PAUSED: "ปิดชั่วคราว", INACTIVE: "เลิกใช้งาน", PENDING: "รอจัดสรร", PARTIAL: "จัดสรรบางส่วน", ALLOCATED: "จัดสรรครบ", SENT: "ส่งสินค้าแล้ว", CANCELLED: "ยกเลิก" })[status] || status; }
function badge(status) { return `<span class="badge ${String(status).toLowerCase()}">${statusLabel(status)}</span>`; }
function flash(message, isError = false) { return `<div class="flash ${isError ? "error" : ""}">${escapeHtml(message)}</div>`; }
function showMessage(message, isError = false) { const target = document.querySelector("[data-flash]"); if (target) target.innerHTML = flash(message, isError); else alert(message); }

function authShell(content) { return `<div class="auth"><aside class="brand-panel"><div><div class="brand">JIB<small>DEMAND PORTAL</small></div></div><p class="brand-note">ระบบแจ้งความต้องการสินค้า ติดตามการจัดสรร และตรวจสอบวันเวลาส่งสินค้าของแต่ละสาขา</p></aside><section class="auth-body">${content}</section></div>`; }

function renderLogin() {
  app.innerHTML = authShell(`<section class="card"><h1>เข้าสู่ระบบแจ้งความต้องการสินค้า</h1><p class="muted">ใช้บัญชีที่ส่วนกลางกำหนดให้สำหรับสาขาของคุณ</p><div data-flash></div><form class="form" id="login-form"><label class="field">ชื่อผู้ใช้งาน<input name="username" required autocomplete="username" placeholder="um หรือ JIB284" /></label><label class="field">รหัสผ่าน<input name="password" type="password" required autocomplete="current-password" /></label><button class="btn btn-primary" type="submit">เข้าสู่ระบบ</button></form></section>`);
  document.querySelector("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const result = await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); state.user = result.user; state.page = state.user.role === "ADMIN" ? "dashboard" : "catalog"; await renderApp(); } catch (error) { showMessage(error.message, true); } });
}

function shell(content) {
  const isAdmin = state.user.role === "ADMIN";
  const nav = isAdmin ? [["dashboard", "ภาพรวม"], ["branches", "ข้อมูลสาขา"], ["parts", "จัดการ Part"], ["admin-orders", "ความต้องการและจัดสรร"], ["import", "นำเข้า Excel"]] : [["catalog", "แจ้งความต้องการ"], ["orders", "รายการของฉัน"]];
  return `<div class="shell"><aside class="sidebar"><div class="brand">JIB<small>DEMAND PORTAL</small></div><nav class="nav">${nav.map(([id, label]) => `<button class="${state.page === id ? "active" : ""}" data-page="${id}">${label}</button>`).join("")}</nav><div class="sidebar-foot">${isAdmin ? "ผู้ดูแลระบบส่วนกลาง" : `สาขา ${state.user.branchId}<br>${escapeHtml(state.user.branchName)}`}</div></aside><main class="main ${isAdmin && state.page === "admin-orders" ? "report-main" : ""}"><div class="topbar"><span class="context">${isAdmin ? "WORKSPACE / ส่วนกลาง" : `สาขา ${state.user.branchId} / ${escapeHtml(state.user.branchName)}`}</span><button class="btn btn-outline btn-small" id="logout">ออกจากระบบ</button></div><div data-flash></div>${content}</main></div>`;
}

async function renderApp() {
  if (!state.user) return boot();
  if (state.user.mustChangePassword) return renderChangePassword();
  const pages = { dashboard: renderDashboard, branches: renderBranches, parts: renderParts, "admin-orders": renderAdminOrders, import: renderImport, catalog: renderCatalog, orders: renderOrders };
  const renderer = pages[state.page] || (state.user.role === "ADMIN" ? renderDashboard : renderCatalog);
  await renderer();
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", async () => { state.page = button.dataset.page; await renderApp(); }));
  document.querySelector("#logout")?.addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); state.user = null; state.cart.clear(); await boot(); });
}

function renderChangePassword() {
  app.innerHTML = shell(`<section class="card"><h1>เปลี่ยนรหัสผ่านครั้งแรก</h1><p class="muted">เพื่อความปลอดภัย กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งานระบบ</p><div data-flash></div><form class="form" id="change-password-form"><label class="field">รหัสผ่านใหม่ (อย่างน้อย 4 ตัวอักษร)<input name="password" type="password" minlength="4" required autocomplete="new-password" /></label><label class="field">ยืนยันรหัสผ่านใหม่<input name="confirmPassword" type="password" minlength="4" required autocomplete="new-password" /></label><button class="btn btn-primary" type="submit">บันทึกรหัสผ่านใหม่</button></form></section>`);
  document.querySelector("#change-password-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); if (form.password !== form.confirmPassword) return showMessage("ยืนยันรหัสผ่านไม่ตรงกัน", true); try { const result = await api("/api/change-password", { method: "POST", body: JSON.stringify({ password: form.password }) }); state.user = result.user; state.page = state.user.role === "ADMIN" ? "dashboard" : "catalog"; await renderApp(); } catch (error) { showMessage(error.message, true); } });
}

async function renderDashboard() {
  const summary = await api("/api/admin/summary");
  app.innerHTML = shell(`<section class="page-header"><div><h1>ภาพรวมความต้องการสินค้า</h1><p>ติดตามรายการที่รอจัดสรรและรอส่งสินค้า</p></div><button class="btn btn-primary" data-page="admin-orders">ดูรายการที่รอดำเนินการ</button></section><section class="grid grid-3"><article class="stat"><label>รายการทั้งหมด</label><strong>${summary.totalOrders}</strong></article><article class="stat"><label>รอจัดสรร</label><strong>${summary.pendingOrders}</strong></article><article class="stat"><label>จัดสรรแล้ว รอส่ง</label><strong>${summary.allocatedOrders}</strong></article></section><section class="panel" style="margin-top:18px"><h2>การมีส่วนร่วมของสาขา</h2><p class="muted">มีสาขาแจ้งความต้องการแล้ว ${summary.participatingBranches} สาขา</p><button class="btn btn-primary" data-page="admin-orders">จัดการความต้องการ</button></section>`);
}

async function renderBranches() {
  const { branches } = await api("/api/branches");
  app.innerHTML = shell(`<section class="page-header"><div><h1>ข้อมูลสาขา</h1><p>เพิ่ม แก้ไข หรือลบสาขาที่ใช้ระบบแจ้งความต้องการสินค้า</p></div><button class="btn btn-primary" id="add-branch">+ เพิ่มสาขา</button></section>${branches.length ? `<section class="branch-list">${branches.map((branch) => `<article class="branch-card"><div class="branch-card-head"><span class="branch-id">สาขา ${branch.id}</span><button class="btn btn-outline btn-small" data-edit-branch="${branch.id}">แก้ไข</button></div><h2>${escapeHtml(branch.name)}</h2><div class="branch-account"><span>บัญชีเข้าสู่ระบบ</span><b>${escapeHtml(branch.username || `JIB${branch.id}`)}</b></div></article>`).join("")}</section>` : `<section class="panel empty">ยังไม่มีสาขา</section>`}`);
  document.querySelector("#add-branch").onclick = () => branchDialog();
  document.querySelectorAll("[data-edit-branch]").forEach((button) => button.onclick = () => branchDialog(branches.find((branch) => String(branch.id) === button.dataset.editBranch)));
}

function branchDialog(branch) {
  const existing = Boolean(branch); const modal = document.createElement("div"); modal.className = "dialog-backdrop";
  modal.innerHTML = `<form class="dialog form" id="branch-form"><h2>${existing ? "แก้ไขสาขา" : "เพิ่มสาขา"}</h2><label class="field">รหัสสาขา *<input name="id" type="number" min="1" max="99999" ${existing ? "readonly" : ""} value="${branch?.id || ""}" required /></label><label class="field">ชื่อสาขา *<input name="name" maxlength="200" value="${escapeHtml(branch?.name || "")}" required /></label>${existing ? "" : `<p class="muted">ระบบจะสร้างบัญชี JIB&lt;รหัสสาขา&gt; พร้อมรหัสเริ่มต้นของระบบ และบังคับเปลี่ยนรหัสผ่านเมื่อเข้าใช้ครั้งแรก</p>`}<div class="dialog-footer">${existing ? `<button class="btn btn-danger" type="button" id="remove-branch">ลบสาขา</button>` : ""}<button class="btn btn-outline" type="button" data-close>ยกเลิก</button><button class="btn btn-primary" type="submit">บันทึก</button></div></form>`;
  document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("#branch-form").addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); data.id = Number(data.id); try { await api(existing ? `/api/branches/${branch.id}` : "/api/branches", { method: existing ? "PATCH" : "POST", body: JSON.stringify(data) }); modal.remove(); await renderBranches(); } catch (error) { showMessage(error.message, true); } });
  modal.querySelector("#remove-branch")?.addEventListener("click", async () => { if (!confirm(`ยืนยันลบสาขา ${branch.name}? บัญชีสาขาจะไม่สามารถเข้าสู่ระบบได้`)) return; try { await api(`/api/branches/${branch.id}`, { method: "DELETE" }); modal.remove(); await renderBranches(); showMessage("ลบสาขาแล้ว"); } catch (error) { showMessage(error.message, true); } });
}

async function renderParts() {
  const { parts } = await api("/api/parts"); state.parts = parts;
  app.innerHTML = shell(`<section class="page-header"><div><h1>จัดการ Part สินค้า</h1><p>เพิ่ม แก้ไข ปิดชั่วคราว หรือเลิกใช้งานสินค้า</p></div><button class="btn btn-primary" id="add-part">+ เพิ่ม Part</button></section><section class="toolbar"><label class="field">ค้นหา<input id="part-search" placeholder="รหัส Part หรือชื่อสินค้า" /></label><label class="field compact">สถานะ<select id="part-status"><option value="">ทั้งหมด</option><option value="OPEN">เปิดรับแจ้งความต้องการ</option><option value="PAUSED">ปิดชั่วคราว</option><option value="INACTIVE">เลิกใช้งาน</option></select></label><button class="btn btn-outline" data-page="import">นำเข้า Excel</button></section><section class="table-wrap"><table class="table"><thead><tr><th>สินค้า / Part</th><th>ราคาขาย</th><th>สถานะ</th><th>จัดการ</th></tr></thead><tbody id="parts-body"></tbody></table></section>`);
  const draw = () => { const search = document.querySelector("#part-search").value.toLowerCase(); const status = document.querySelector("#part-status").value; const rows = state.parts.filter((part) => (!status || part.status === status) && `${part.id} ${part.name}`.toLowerCase().includes(search)); document.querySelector("#parts-body").innerHTML = rows.length ? rows.map((part) => `<tr><td><b>${escapeHtml(part.name)}</b><span class="part">${escapeHtml(part.id)}</span></td><td>${money.format(part.sell_price)}</td><td>${badge(part.status)}</td><td><button class="btn btn-outline btn-small" data-edit-part="${escapeHtml(part.id)}">แก้ไข</button></td></tr>`).join("") : `<tr><td colspan="4" class="empty">ไม่พบ Part</td></tr>`; document.querySelectorAll("[data-edit-part]").forEach((button) => button.addEventListener("click", () => partDialog(state.parts.find((part) => part.id === button.dataset.editPart)))); };
  draw(); document.querySelector("#part-search").addEventListener("input", draw); document.querySelector("#part-status").addEventListener("change", draw); document.querySelector("#add-part").addEventListener("click", () => partDialog());
}

function partDialog(part) {
  const existing = Boolean(part); const modal = document.createElement("div"); modal.className = "dialog-backdrop";
  modal.innerHTML = `<form class="dialog form" id="part-form"><h2>${existing ? "แก้ไข Part สินค้า" : "เพิ่ม Part สินค้า"}</h2><label class="field">รหัส Part *<input name="id" ${existing ? "readonly" : ""} value="${escapeHtml(part?.id || "")}" required /></label><label class="field">ชื่อสินค้า *<input name="name" value="${escapeHtml(part?.name || "")}" required /></label><label class="field">ราคาขาย (บาท) *<input name="sellPrice" type="number" min="0" step="1" value="${part?.sell_price ?? ""}" required /></label><label class="field">สถานะ<select name="status">${["OPEN", "PAUSED", "INACTIVE"].map((status) => `<option value="${status}" ${part?.status === status ? "selected" : ""}>${statusLabel(status)}</option>`).join("")}</select></label><p class="muted">การแก้ชื่อหรือราคาจะไม่เปลี่ยนข้อมูลในรายการความต้องการเดิม</p><div class="dialog-footer">${existing ? `<button class="btn btn-danger" type="button" id="remove-part">${part.status === "INACTIVE" ? "ลบ Part" : "เลิกใช้งาน / ลบ"}</button>` : ""}<button class="btn btn-outline" type="button" data-close>ยกเลิก</button><button class="btn btn-primary" type="submit">บันทึก</button></div></form>`;
  document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("#part-form").addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); data.sellPrice = Number(data.sellPrice); try { await api(existing ? `/api/parts/${encodeURIComponent(part.id)}` : "/api/parts", { method: existing ? "PATCH" : "POST", body: JSON.stringify(data) }); modal.remove(); await renderParts(); } catch (error) { showMessage(error.message, true); } });
  modal.querySelector("#remove-part")?.addEventListener("click", async () => { if (!confirm("ยืนยันการเลิกใช้งานหรือลบ Part นี้?")) return; try { const result = await api(`/api/parts/${encodeURIComponent(part.id)}`, { method: "DELETE" }); modal.remove(); await renderParts(); showMessage(result.inactivated ? "Part มีประวัติความต้องการสินค้า จึงเปลี่ยนเป็นเลิกใช้งานแล้ว" : "ลบ Part แล้ว"); } catch (error) { showMessage(error.message, true); } });
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

async function renderCatalog() {
  const { items } = await api("/api/catalog"); state.catalog = items;
  app.innerHTML = shell(`<section class="page-header"><div><h1>แจ้งความต้องการสินค้า</h1><p>เลือกรุ่นและระบุจำนวนที่ลูกค้าต้องการ โดยไม่มีการจำกัดโควต้า</p></div><button class="btn btn-outline branch-orders-action" data-page="orders">รายการของฉัน</button></section><section class="toolbar"><label class="field">ค้นหารุ่นสินค้า<input id="catalog-search" placeholder="รหัส Part หรือชื่อรุ่น" /></label></section><section class="product-list" id="catalog-body"></section><section class="cart" id="cart"></section>`);
  const draw = () => { const search = document.querySelector("#catalog-search").value.toLowerCase(); const rows = items.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(search)); document.querySelector("#catalog-body").innerHTML = rows.length ? rows.map((item) => { const qty = state.cart.get(item.id)?.quantity || 0; return `<article class="product-card"><div><span class="part">${escapeHtml(item.id)}</span><h2>${escapeHtml(item.name)}</h2></div><div class="product-meta"><span>ราคาขายอ้างอิง</span><b>${money.format(item.sell_price)}</b></div><div class="product-quantity"><span>จำนวนที่ต้องการ</span><span class="qty"><button data-qty="-1" data-part="${escapeHtml(item.id)}" aria-label="ลดจำนวน ${escapeHtml(item.name)}">−</button><strong>${qty}</strong><button data-qty="1" data-part="${escapeHtml(item.id)}" aria-label="เพิ่มจำนวน ${escapeHtml(item.name)}">+</button></span></div></article>`; }).join("") : `<section class="panel empty">ยังไม่มีสินค้าที่เปิดรับแจ้งความต้องการ</section>`; document.querySelectorAll("[data-qty]").forEach((button) => button.onclick = () => changeCart(button.dataset.part, Number(button.dataset.qty))); drawCart(); };
  const drawCart = () => { const entries = [...state.cart.values()]; const total = entries.reduce((sum, item) => sum + item.quantity, 0); document.querySelector("#cart").innerHTML = total ? `<div><b>${entries.length} รุ่น / ${total} เครื่อง</b><small>ระบุชื่อลูกค้าในขั้นตอนถัดไป</small></div><button class="btn btn-primary" id="checkout">ตรวจสอบและส่ง</button>` : `<div><b>ยังไม่ได้เลือกรุ่นสินค้า</b><small>กด + เพื่อระบุจำนวนที่ลูกค้าต้องการ</small></div>`; document.querySelector("#checkout")?.addEventListener("click", checkoutDialog); };
  window.changeCart = (partId, delta) => { const item = items.find((entry) => entry.id === partId); const next = (state.cart.get(partId)?.quantity || 0) + delta; if (next <= 0) state.cart.delete(partId); else state.cart.set(partId, { ...item, quantity: next }); draw(); };
  draw(); document.querySelector("#catalog-search").addEventListener("input", draw);
}

function checkoutDialog() {
  const entries = [...state.cart.values()]; if (!entries.length) return showMessage("เลือกสินค้าอย่างน้อย 1 รายการ", true);
  const modal = document.createElement("div"); modal.className = "dialog-backdrop"; const total = entries.reduce((sum, item) => sum + item.quantity * item.sell_price, 0);
  modal.innerHTML = `<form class="dialog form" id="checkout-form"><h2>ยืนยันความต้องการสินค้า</h2><label class="field">ชื่อลูกค้า *<input name="customerName" maxlength="200" required placeholder="ระบุชื่อลูกค้า" /></label><div class="demand-review-list">${entries.map((item) => `<div><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.id)}</small></span><strong>${item.quantity} เครื่อง</strong></div>`).join("")}</div><p><b>รวม ${entries.reduce((sum, item) => sum + item.quantity, 0)} เครื่อง · ${money.format(total)}</b></p><label class="field">หมายเหตุถึงส่วนกลาง<textarea name="note" placeholder="ระบุหมายเหตุเพิ่มเติม (ถ้ามี)"></textarea></label><div class="dialog-footer"><button class="btn btn-outline" type="button" data-close>กลับไปแก้ไข</button><button class="btn btn-primary" type="submit">ยืนยันส่งรายการ</button></div></form>`; document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("#checkout-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const { orderId } = await api("/api/orders", { method: "POST", body: JSON.stringify({ customerName: form.get("customerName"), note: form.get("note"), items: entries.map((item) => ({ partId: item.id, quantity: item.quantity })) }) }); state.cart.clear(); state.page = "orders"; modal.remove(); await renderApp(); showMessage(`ส่งรายการสำเร็จ: ${orderId}`); } catch (error) { showMessage(error.message, true); } };
}

async function renderOrders() {
  const { orders } = await api("/api/orders"); state.orders = orders;
  app.innerHTML = shell(`<section class="page-header"><div><h1>รายการความต้องการของฉัน</h1><p>ดูสินค้าและสถานะของแต่ละคำขอได้ในหน้าเดียว</p></div><button class="btn btn-primary" data-page="catalog">+ สร้างรายการใหม่</button></section>${orders.length ? `<section class="order-list">${orders.map((order) => `<article class="order-card branch-order-card"><div class="order-card-head"><div><small>เลขที่คำขอ</small><b>${escapeHtml(order.id)}</b></div>${badge(order.status)}</div><div class="branch-order-main"><div class="branch-order-title"><div><small>ชื่อลูกค้า</small><h2>${escapeHtml(order.customer_name)}</h2></div><div class="order-total"><span>${order.items.length.toLocaleString("th-TH")} Part</span><b>ต้องการ ${Number(order.requested_total).toLocaleString("th-TH")} เครื่อง</b></div></div><div class="order-items"><div class="order-item order-item-heading"><span>สินค้า / Part</span><span>ต้องการ</span><span>จัดสรร</span></div>${order.items.map((item) => `<div class="order-item"><div class="order-item-name"><b>${escapeHtml(item.part_name_snapshot)}</b><small>${escapeHtml(item.part_id)}</small></div><strong>${Number(item.requested_quantity).toLocaleString("th-TH")} เครื่อง</strong><strong class="allocated-count">${Number(item.allocated_quantity).toLocaleString("th-TH")} เครื่อง</strong></div>`).join("")}</div>${order.note ? `<p class="order-note"><b>หมายเหตุ:</b> ${escapeHtml(order.note)}</p>` : ""}</div><div class="branch-order-footer"><div class="order-stamps"><span>แจ้งเมื่อ <b>${fmtDate(order.created_at)}</b></span>${order.allocated_at ? `<span>จัดสรรเมื่อ <b>${fmtDate(order.allocated_at)}</b></span>` : ""}${order.sent_at ? `<span>ส่งสินค้าเมื่อ <b>${fmtDate(order.sent_at)}</b></span>` : ""}</div>${order.status === "PENDING" ? `<div class="order-actions"><button class="btn btn-outline btn-small" data-edit-order="${escapeHtml(order.id)}">แก้ไข</button><button class="btn btn-danger btn-small" data-cancel-order="${escapeHtml(order.id)}">ยกเลิก</button></div>` : ""}</div></article>`).join("")}</section>` : `<section class="panel empty">ยังไม่มีรายการความต้องการ</section>`}`);
  document.querySelectorAll("[data-edit-order]").forEach((button) => button.onclick = () => editOrderDialog(button.dataset.editOrder));
  document.querySelectorAll("[data-cancel-order]").forEach((button) => button.onclick = async () => { if (!confirm("ยืนยันยกเลิกรายการนี้?")) return; try { await api(`/api/orders/${encodeURIComponent(button.dataset.cancelOrder)}`, { method: "DELETE" }); await renderOrders(); showMessage("ยกเลิกรายการแล้ว"); } catch (error) { showMessage(error.message, true); } });
}

async function editOrderDialog(orderId) {
  try {
    const { order, items } = await api(`/api/orders/${encodeURIComponent(orderId)}`); const modal = document.createElement("div"); modal.className = "dialog-backdrop";
    modal.innerHTML = `<form class="dialog form" id="edit-order-form"><h2>แก้ไขรายการความต้องการ</h2><label class="field">ชื่อลูกค้า *<input name="customerName" maxlength="200" required value="${escapeHtml(order.customer_name)}" /></label><div class="allocation-list">${items.map((item) => `<label><span><b>${escapeHtml(item.part_name_snapshot)}</b><small>${escapeHtml(item.part_id)}</small></span><input data-item="${item.id}" type="number" min="1" max="9999" value="${item.requested_quantity}" required /></label>`).join("")}</div><label class="field">หมายเหตุ<textarea name="note">${escapeHtml(order.note || "")}</textarea></label><div class="dialog-footer"><button class="btn btn-outline" type="button" data-close>ยกเลิก</button><button class="btn btn-primary" type="submit">บันทึกการแก้ไข</button></div></form>`;
    document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
    modal.querySelector("#edit-order-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const payload = { customerName: form.get("customerName"), note: form.get("note"), items: [...modal.querySelectorAll("[data-item]")].map((input) => ({ itemId: input.dataset.item, quantity: Number(input.value) })) }; try { await api(`/api/orders/${encodeURIComponent(orderId)}`, { method: "PATCH", body: JSON.stringify(payload) }); modal.remove(); await renderOrders(); showMessage("แก้ไขรายการแล้ว"); } catch (error) { showMessage(error.message, true); } };
  } catch (error) { showMessage(error.message, true); }
}

async function renderAdminOrders() {
  const { rows: reportRows } = await api("/api/admin/orders/export");
  let page = 1; const pageSize = 20;
  app.innerHTML = shell(`<section class="page-header report-header"><div><h1>รายงานความต้องการและการจัดสรร</h1><p>แสดง 1 Part ต่อ 1 บรรทัด เรียงตามวันเวลาที่แจ้ง และส่งออกข้อมูล</p></div><button class="btn btn-excel" id="export-orders"><span aria-hidden="true">▦</span> Export Excel</button></section><section class="toolbar report-toolbar"><label class="field report-search">ค้นหา<input id="admin-order-search" placeholder="ลูกค้า สาขา รุ่น Part หรือเลขที่รายการ" /></label><label class="field">วันที่เริ่มต้น<input id="admin-order-start" type="date" /></label><label class="field">วันที่สิ้นสุด<input id="admin-order-end" type="date" /></label><label class="field compact">สถานะ<select id="admin-order-status"><option value="">ทั้งหมด</option><option value="PENDING">รอจัดสรร</option><option value="PARTIAL">จัดสรรบางส่วน</option><option value="ALLOCATED">จัดสรรครบ</option><option value="SENT">ส่งสินค้าแล้ว</option><option value="CANCELLED">ยกเลิก</option></select></label><label class="field compact">เรียงตาม<select id="admin-order-sort"><option value="desc">ใหม่สุดก่อน</option><option value="asc">เก่าสุดก่อน</option></select></label></section><section class="report-summary" id="admin-report-summary"></section><section class="table-wrap report-table-wrap"><table class="table report-table"><thead><tr><th class="sticky-date"><button class="sort-heading" id="sort-request-date" type="button">วัน–เวลาที่แจ้ง <span aria-hidden="true">↓</span></button></th><th>เลขที่คำขอ</th><th>สาขา</th><th>ลูกค้า</th><th>สินค้า / Part</th><th class="number-column">ต้องการ</th><th class="number-column">จัดสรร</th><th>สถานะ</th><th>จัดการ</th></tr></thead><tbody id="admin-report-body"></tbody></table><footer class="report-pagination" id="admin-report-pagination"></footer></section>`);

  const filterRows = () => {
    const search = document.querySelector("#admin-order-search").value.trim().toLowerCase();
    const status = document.querySelector("#admin-order-status").value;
    const start = document.querySelector("#admin-order-start").value;
    const end = document.querySelector("#admin-order-end").value;
    const direction = document.querySelector("#admin-order-sort").value;
    return reportRows.filter((row) => {
      const requestDate = bangkokDateKey(row.created_at);
      return (!status || row.status === status) && (!start || requestDate >= start) && (!end || requestDate <= end)
        && (!search || `${row.request_id} ${row.customer_name} ${row.branch_id} ${row.branch_name} ${row.part_id} ${row.part_name_snapshot}`.toLowerCase().includes(search));
    }).sort((left, right) => {
      const byDate = (timestamp(left.created_at).getTime() - timestamp(right.created_at).getTime()) * (direction === "asc" ? 1 : -1);
      return byDate || String(left.request_id).localeCompare(String(right.request_id)) || String(left.part_id).localeCompare(String(right.part_id));
    });
  };

  const draw = () => {
    const rows = filterRows(); const totalPages = Math.max(1, Math.ceil(rows.length / pageSize)); page = Math.min(page, totalPages);
    const visible = rows.slice((page - 1) * pageSize, page * pageSize);
    document.querySelector("#admin-report-summary").innerHTML = `<article><span>ทั้งหมด</span><b>${rows.length.toLocaleString("th-TH")} Part</b></article><article><span>ต้องการ</span><b>${rows.reduce((sum, row) => sum + Number(row.requested_quantity), 0).toLocaleString("th-TH")} เครื่อง</b></article><article><span>จัดสรรแล้ว</span><b>${rows.reduce((sum, row) => sum + Number(row.allocated_quantity), 0).toLocaleString("th-TH")} เครื่อง</b></article>`;
    document.querySelector("#admin-report-body").innerHTML = visible.length ? visible.map((row) => `<tr><td class="sticky-date"><time datetime="${escapeHtml(row.created_at)}">${fmtDate(row.created_at)}</time></td><td><b class="request-id">${escapeHtml(row.request_id)}</b></td><td><b>${escapeHtml(row.branch_name)}</b><small>JIB${escapeHtml(row.branch_id)}</small></td><td>${escapeHtml(row.customer_name)}</td><td class="product-cell" title="${escapeHtml(row.part_name_snapshot)}"><b>${escapeHtml(row.part_name_snapshot)}</b><small>${escapeHtml(row.part_id)}</small></td><td class="number-column"><b>${Number(row.requested_quantity).toLocaleString("th-TH")}</b></td><td class="number-column"><b>${Number(row.allocated_quantity).toLocaleString("th-TH")}</b></td><td>${badge(row.status)}</td><td><button class="btn btn-outline btn-small" data-allocate="${escapeHtml(row.request_id)}">${row.status === "PENDING" ? "จัดสรรสินค้า" : "ดูรายละเอียด"}</button></td></tr>`).join("") : `<tr><td colspan="9" class="empty">ไม่พบรายการความต้องการตามตัวกรอง</td></tr>`;
    const first = rows.length ? (page - 1) * pageSize + 1 : 0; const last = Math.min(page * pageSize, rows.length);
    document.querySelector("#admin-report-pagination").innerHTML = `<span>แสดง ${first.toLocaleString("th-TH")}–${last.toLocaleString("th-TH")} จาก ${rows.length.toLocaleString("th-TH")} Part</span><div><button class="btn btn-outline btn-small" id="report-prev" ${page === 1 ? "disabled" : ""} aria-label="หน้าก่อนหน้า">‹</button><b>${page.toLocaleString("th-TH")} / ${totalPages.toLocaleString("th-TH")}</b><button class="btn btn-outline btn-small" id="report-next" ${page === totalPages ? "disabled" : ""} aria-label="หน้าถัดไป">›</button></div>`;
    document.querySelectorAll("[data-allocate]").forEach((button) => button.onclick = () => allocationDialog(button.dataset.allocate));
    document.querySelector("#report-prev").onclick = () => { page -= 1; draw(); };
    document.querySelector("#report-next").onclick = () => { page += 1; draw(); };
    const descending = document.querySelector("#admin-order-sort").value === "desc"; document.querySelector("#sort-request-date span").textContent = descending ? "↓" : "↑";
    document.querySelector("#sort-request-date").closest("th").setAttribute("aria-sort", descending ? "descending" : "ascending");
    document.querySelector("#export-orders").disabled = rows.length === 0;
  };

  ["#admin-order-search", "#admin-order-start", "#admin-order-end", "#admin-order-status", "#admin-order-sort"].forEach((selector) => document.querySelector(selector).addEventListener(selector === "#admin-order-search" ? "input" : "change", () => { page = 1; draw(); }));
  document.querySelector("#sort-request-date").onclick = () => { const input = document.querySelector("#admin-order-sort"); input.value = input.value === "desc" ? "asc" : "desc"; page = 1; draw(); };
  document.querySelector("#export-orders").onclick = async () => exportAdminOrders(filterRows());
  draw();
}

async function exportAdminOrders(filteredRows) {
  if (!window.XLSX) return showMessage("ยังโหลดตัวส่งออก Excel ไม่สำเร็จ กรุณารีเฟรชแล้วลองอีกครั้ง", true);
  const button = document.querySelector("#export-orders"); button.disabled = true; button.textContent = "กำลังสร้างไฟล์…";
  try {
    const safe = (value) => { const text = String(value ?? ""); return /^[=+\-@]/.test(text) ? `'${text}` : text; };
    const output = filteredRows.map((row) => ({
      "วัน–เวลาที่แจ้ง": timestamp(row.created_at), "เลขที่คำขอ": safe(row.request_id), "รหัสสาขา": `JIB${row.branch_id}`, "สาขา": safe(row.branch_name), "ลูกค้า": safe(row.customer_name),
      "Part": safe(row.part_id), "สินค้า": safe(row.part_name_snapshot), "ราคาขายอ้างอิง": Number(row.sell_price_snapshot), "จำนวนที่ต้องการ": Number(row.requested_quantity), "จำนวนที่จัดสรร": Number(row.allocated_quantity),
      "สถานะ": statusLabel(row.status), "วัน–เวลาจัดสรร": row.allocated_at ? timestamp(row.allocated_at) : "", "ผู้จัดสรร": safe(row.allocated_by_name), "วัน–เวลาส่งสินค้า": row.sent_at ? timestamp(row.sent_at) : "", "ผู้บันทึกส่ง": safe(row.sent_by_name),
      "หมายเหตุสาขา": safe(row.note), "หมายเหตุส่วนกลาง": safe(row.admin_note),
    }));
    const worksheet = XLSX.utils.json_to_sheet(output, { cellDates: true });
    worksheet["!cols"] = [20, 27, 12, 26, 22, 22, 48, 18, 17, 17, 20, 20, 18, 20, 18, 30, 30].map((wch) => ({ wch }));
    worksheet["!autofilter"] = { ref: worksheet["!ref"] };
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, "Demand Report");
    XLSX.writeFile(workbook, `JIB-Demand-Report-${bangkokDateKey(new Date())}.xlsx`, { compression: true });
    showMessage(`ส่งออก Excel สำเร็จ ${output.length.toLocaleString("th-TH")} บรรทัด`);
  } catch (error) { showMessage(error.message, true); }
  finally { button.disabled = false; button.innerHTML = `<span aria-hidden="true">▦</span> Export Excel`; }
}

async function allocationDialog(orderId) {
  try {
    const { order, items } = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`); const modal = document.createElement("div"); modal.className = "dialog-backdrop";
    const closed = ["SENT", "CANCELLED"].includes(order.status);
    modal.innerHTML = `<form class="dialog form" id="allocation-form"><div class="order-card-head"><h2>รายละเอียดความต้องการ</h2>${badge(order.status)}</div><div class="notice"><b>${escapeHtml(order.customer_name)}</b><br>${escapeHtml(order.branch_name)} · ${escapeHtml(order.id)}<br><small>แจ้งเมื่อ ${fmtDate(order.created_at)}</small></div><div class="allocation-list">${items.map((item) => `<label><span><b>${escapeHtml(item.part_name_snapshot)}</b><small>${escapeHtml(item.part_id)} · ต้องการ ${item.requested_quantity} เครื่อง</small></span><input data-item="${item.id}" type="number" min="0" max="${item.requested_quantity}" value="${item.allocated_quantity ?? 0}" ${closed ? "disabled" : ""} aria-label="จำนวนจัดสรร ${escapeHtml(item.part_name_snapshot)}" /></label>`).join("")}</div><label class="field">หมายเหตุถึงสาขา<textarea name="adminNote" ${closed ? "disabled" : ""}>${escapeHtml(order.admin_note || "")}</textarea></label>${order.allocated_at ? `<p class="stamp">จัดสรรเมื่อ ${fmtDate(order.allocated_at)} โดย ${escapeHtml(order.allocated_by_name || "ผู้ดูแล")}</p>` : ""}${order.sent_at ? `<p class="stamp sent-stamp">ส่งสินค้าเมื่อ ${fmtDate(order.sent_at)} โดย ${escapeHtml(order.sent_by_name || "ผู้ดูแล")}</p>` : ""}<div class="dialog-footer"><button class="btn btn-outline" data-close type="button">ปิด</button>${!closed ? `<button class="btn btn-primary" type="submit">บันทึกการจัดสรร</button>` : ""}${["PARTIAL", "ALLOCATED"].includes(order.status) ? `<button class="btn btn-success" id="mark-sent" type="button">ส่งสินค้าแล้ว</button>` : ""}</div></form>`;
    document.body.append(modal); modal.querySelector("[data-close]").onclick = () => modal.remove();
    modal.querySelector("#allocation-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const itemsPayload = [...modal.querySelectorAll("[data-item]")].map((input) => ({ itemId: input.dataset.item, allocatedQuantity: Number(input.value), note: "" })); try { await api(`/api/admin/orders/${encodeURIComponent(orderId)}/allocation`, { method: "PATCH", body: JSON.stringify({ items: itemsPayload, adminNote: form.get("adminNote") }) }); modal.remove(); await renderAdminOrders(); showMessage("บันทึกการจัดสรรและเวลาแล้ว"); } catch (error) { showMessage(error.message, true); } };
    modal.querySelector("#mark-sent")?.addEventListener("click", async () => { if (!confirm("ยืนยันว่าได้ส่งสินค้ารายการนี้แล้ว? ระบบจะบันทึกวันเวลาและผู้ดำเนินการ")) return; try { await api(`/api/admin/orders/${encodeURIComponent(orderId)}/sent`, { method: "POST" }); modal.remove(); await renderAdminOrders(); showMessage("บันทึกว่าส่งสินค้าแล้ว"); } catch (error) { showMessage(error.message, true); } });
  } catch (error) { showMessage(error.message, true); }
}

async function boot() {
  try { const { user } = await api("/api/me"); state.user = user; state.page = user.role === "ADMIN" ? "dashboard" : "catalog"; await renderApp(); } catch (error) { if (error.message.includes("เข้าสู่ระบบ") || error.message.includes("เซสชัน")) return renderLogin(); app.innerHTML = authShell(`<section class="card"><h1>ไม่สามารถเริ่มระบบได้</h1>${flash(error.message, true)}</section>`); } }

boot();
