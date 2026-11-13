const requiredColumns = ["Branch", "Product", "Name", "Number", "ราคารวมก่อน Vat", "ราคารวมหลัง Vat"];
const amount = new Intl.NumberFormat("th-TH");
const baht = new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", minimumFractionDigits: 2 });

function columnIndex(headers, name) {
  return headers.findIndex(header => header.toLowerCase() === name.toLowerCase());
}

export function parseInventoryWorkbook(xlsx, buffer) {
  const workbook = xlsx.read(buffer, { type: "array" });
  for (const sheet of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheet];
    if (!worksheet?.["!ref"]) continue;
    const range = xlsx.utils.decode_range(worksheet["!ref"]);
    if (range.e.c - range.s.c >= 60 || range.e.r - range.s.r > 10000) continue;
    const [headerRow, ...data] = xlsx.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: "", blankrows: true });
    const headers = (headerRow || []).map(value => String(value ?? "").trim());
    const [branch, product, name, number, beforeVat, afterVat] = requiredColumns.map(column => columnIndex(headers, column));
    if ([branch, product, name, number, beforeVat, afterVat].includes(-1)) continue;
    if (headers.some(header => !header || header.length > 120) || new Set(headers.map(header => header.toLowerCase())).size !== headers.length) {
      throw new Error("พบหัวคอลัมน์ว่างหรือซ้ำกันในไฟล์ Inventory");
    }
    const rows = [];
    for (const [index, cells] of data.entries()) {
      if (!cells.some(cell => String(cell ?? "").trim())) continue;
      const row = headers.map((_, i) => typeof cells[i] === "number" ? cells[i] : String(cells[i] ?? ""));
      for (const i of [number, beforeVat, afterVat]) {
        const value = String(row[i]).trim();
        row[i] = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value) ? Number(value.replaceAll(",", "")) : NaN;
      }
      if (![branch, product, name].every(i => String(row[i]).trim()) ||
          !Number.isSafeInteger(row[number]) || !Number.isFinite(row[beforeVat]) || !Number.isFinite(row[afterVat]) ||
          row.some(cell => typeof cell === "string" && cell.length > 1000)) {
        throw new Error("ข้อมูล Inventory ไม่ถูกต้องที่แถว " + (range.s.r + index + 2));
      }
      rows.push(row);
    }
    if (!rows.length) throw new Error("ไม่พบรายการสินค้าในชีต " + sheet);
    return { sheet, headers, rows };
  }
  throw new Error("ไม่พบชีต Inventory ที่มีคอลัมน์ Branch, Product, Name, Number และราคารวมก่อน/หลัง Vat หรือชีตมีขนาดเกินที่รองรับ");
}

export function summarizeInventory(headers, rows) {
  const [branchIndex, productIndex, , quantity, before, after] = requiredColumns.map(column => columnIndex(headers, column));
  const products = new Set();
  const byBranch = new Map();
  let units = 0, beforeVat = 0, afterVat = 0;
  for (const row of rows) {
    const branch = String(row[branchIndex]).trim();
    const product = String(row[productIndex]).trim().toUpperCase();
    const entry = byBranch.get(branch) || { branch, units: 0, beforeVat: 0, afterVat: 0, products: new Set() };
    const beforeCents = Math.round(row[before] * 100);
    const afterCents = Math.round(row[after] * 100);
    units += row[quantity]; beforeVat += beforeCents; afterVat += afterCents;
    entry.units += row[quantity]; entry.beforeVat += beforeCents; entry.afterVat += afterCents;
    products.add(product); entry.products.add(product); byBranch.set(branch, entry);
  }
  return { units, beforeVat: beforeVat / 100, afterVat: afterVat / 100, products: products.size, branches: [...byBranch.values()]
    .sort((a, b) => b.units - a.units || a.branch.localeCompare(b.branch, "th", { numeric: true }))
    .map(entry => ({ ...entry, beforeVat: entry.beforeVat / 100, afterVat: entry.afterVat / 100, products: entry.products.size })) };
}

export function renderInventory({ app, shell, api, escapeHtml, fmtDate }) {
  app.innerHTML = shell('<section class="page-header"><div><h1>อัปโหลด Inventory</h1><p>ตรวจยอดคงคลังจาก Excel และเปิดดูข้อมูลชุดล่าสุดที่ส่วนกลางบันทึก</p></div></section><section class="panel inventory-upload" id="inventory-upload"><form class="form" id="inventory-form"><label class="field">ไฟล์ Inventory (.xlsx)<input id="inventory-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" /></label><div class="inventory-actions"><button class="btn btn-primary" id="inventory-save" type="submit" disabled>บันทึกเป็นชุดล่าสุด</button><button class="btn btn-outline" id="inventory-discard" type="button" hidden>ยกเลิกตัวอย่าง</button></div></form><p class="muted" id="inventory-message" role="status">กำลังโหลดข้อมูลล่าสุด…</p></section><section id="inventory-content"></section>');
  const form = app.querySelector("#inventory-form");
  const file = form.querySelector("#inventory-file");
  const save = form.querySelector("#inventory-save");
  const discard = form.querySelector("#inventory-discard");
  const message = app.querySelector("#inventory-message");
  const content = app.querySelector("#inventory-content");
  let snapshot = null, preview = null, page = 1, selection = 0;
  const pageSize = 25;
  const status = (text, error = false) => { message.textContent = text; message.classList.toggle("inventory-error", error); };
  const branchLabel = code => /^\d+$/.test(code) ? "JIB" + code : code;
  const td = value => "<td>" + escapeHtml(value) + "</td>";

  function render() {
    const data = preview || snapshot;
    save.disabled = !preview;
    discard.hidden = !preview;
    if (!data) {
      content.innerHTML = '<section class="panel empty">ยังไม่มีชุด Inventory ที่บันทึก เลือกไฟล์เพื่อดูตัวอย่าง</section>';
      return;
    }
    const { headers, rows } = data;
    const [branch, product, name, quantity, before, after] = requiredColumns.map(column => columnIndex(headers, column));
    const serial = columnIndex(headers, "Serial");
    const category = columnIndex(headers, "ประเภทสินค้า");
    const unique = (index) => [...new Set(rows.map(row => String(row[index] ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "th", { numeric: true }));
    const options = (values, label) => values.map(value => '<option value="' + escapeHtml(value) + '">' + escapeHtml(label(value)) + '</option>').join("");
    const meta = preview ? "ตัวอย่างก่อนบันทึก" : "บันทึกเมื่อ " + fmtDate(data.uploadedAt) + " โดย " + data.uploadedBy;
    content.innerHTML = '<section class="inventory-meta"><b>' + escapeHtml(data.filename) + '</b><span>' + escapeHtml(meta + " · ชีต " + data.sheet) + '</span></section>'
      + '<section class="toolbar inventory-toolbar"><label class="field">ค้นหาสินค้า<input id="inventory-search" type="search" placeholder="รหัสสินค้า ชื่อสินค้า หรือ Serial" /></label><label class="field">สาขา<select id="inventory-branch"><option value="">ทุกสาขา</option>' + options(unique(branch), branchLabel) + '</select></label>'
      + (category < 0 ? '' : '<label class="field">ประเภทสินค้า<select id="inventory-category"><option value="">ทุกประเภท</option>' + options(unique(category), value => value) + '</select></label>')
      + '</section><section class="inventory-kpis" id="inventory-kpis" aria-label="สรุป Inventory"></section>'
      + '<details class="panel inventory-branches"><summary>สรุปแยกตามสาขา</summary><div class="table-wrap"><table class="table inventory-table"><thead><tr><th>สาขา</th><th>รหัสสินค้า</th><th>จำนวน</th><th>มูลค่าก่อน VAT</th><th>มูลค่าหลัง VAT</th></tr></thead><tbody id="inventory-branch-summary"></tbody></table></div></details>'
      + '<section class="table-wrap inventory-detail"><table class="table inventory-table"><thead><tr><th>สาขา</th><th>รหัสสินค้า / ชื่อสินค้า</th><th>Serial</th><th>จำนวน</th><th>ราคารวมก่อน VAT</th><th>ราคารวมหลัง VAT</th><th>รายละเอียด</th></tr></thead><tbody id="inventory-rows"></tbody></table><footer class="report-pagination"><span id="inventory-page-label"></span><div><button class="btn btn-outline btn-small" type="button" id="inventory-prev" aria-label="หน้าก่อนหน้า">‹</button><button class="btn btn-outline btn-small" type="button" id="inventory-next" aria-label="หน้าถัดไป">›</button></div></footer></section>'
      + '<dialog class="inventory-dialog" aria-labelledby="inventory-detail-title"><h2 id="inventory-detail-title">รายละเอียด Inventory</h2><dl></dl><form method="dialog"><button class="btn btn-outline">ปิด</button></form></dialog>';
    const get = id => content.querySelector(id);
    const search = get("#inventory-search");
    const branchSelect = get("#inventory-branch");
    const categorySelect = get("#inventory-category");
    const previous = get("#inventory-prev");
    const next = get("#inventory-next");
    const tableBody = get("#inventory-rows");
    const dialog = content.querySelector("dialog");
    let visible = [];
    const draw = () => {
      const query = search.value.trim().toLowerCase();
      const filtered = rows.filter(row =>
        (!branchSelect.value || String(row[branch]).trim() === branchSelect.value) &&
        (!categorySelect?.value || String(row[category]).trim() === categorySelect.value) &&
        (!query || [row[product], row[name], row[serial]].some(cell => String(cell ?? "").toLowerCase().includes(query))));
      const total = summarizeInventory(headers, filtered);
      get("#inventory-kpis").innerHTML = [["จำนวนคงคลัง", amount.format(total.units) + " หน่วย"], ["รหัสสินค้า / สาขา", amount.format(total.products) + " / " + amount.format(total.branches.length)], ["มูลค่าก่อน VAT", baht.format(total.beforeVat)], ["มูลค่าหลัง VAT", baht.format(total.afterVat)]].map(([label, value]) => '<article class="stat"><label>' + label + '</label><strong>' + value + '</strong></article>').join("");
      get("#inventory-branch-summary").innerHTML = total.branches.map(item => "<tr>" + td(branchLabel(item.branch)) + td(amount.format(item.products)) + td(amount.format(item.units)) + td(baht.format(item.beforeVat)) + td(baht.format(item.afterVat)) + "</tr>").join("") || '<tr><td colspan="5" class="empty">ไม่พบสาขาตามตัวกรอง</td></tr>';
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      page = Math.max(1, Math.min(page, totalPages));
      visible = filtered.slice((page - 1) * pageSize, page * pageSize);
      tableBody.innerHTML = visible.map((row, index) => "<tr>" + td(branchLabel(String(row[branch]).trim()))
        + "<td><b>" + escapeHtml(row[product]) + '</b><span class="part">' + escapeHtml(row[name]) + "</span></td>"
        + td(row[serial] || "–") + td(amount.format(row[quantity])) + td(baht.format(row[before])) + td(baht.format(row[after]))
        + '<td><button class="btn btn-outline btn-small" type="button" data-inventory-row="' + index + '">ดูข้อมูล</button></td></tr>').join("")
        || '<tr><td colspan="7" class="empty">ไม่พบรายการตามตัวกรอง</td></tr>';
      get("#inventory-page-label").textContent = "หน้า " + page + " / " + totalPages + " · " + amount.format(filtered.length) + " รายการ";
      previous.disabled = page === 1; next.disabled = page === totalPages;
    };
    search.addEventListener("input", () => { page = 1; draw(); });
    [branchSelect, categorySelect].filter(Boolean).forEach(select => select.addEventListener("change", () => { page = 1; draw(); }));
    previous.addEventListener("click", () => { page -= 1; draw(); });
    next.addEventListener("click", () => { page += 1; draw(); });
    tableBody.addEventListener("click", event => {
      const button = event.target.closest("[data-inventory-row]");
      if (!button) return;
      const row = visible[Number(button.dataset.inventoryRow)];
      dialog.querySelector("dl").innerHTML = headers.map((header, index) => "<div><dt>" + escapeHtml(header) + "</dt><dd>" + escapeHtml(row[index] === "" ? "–" : row[index]) + "</dd></div>").join("");
      dialog.showModal();
    });
    draw();
  }

  const load = async () => {
    file.disabled = true;
    try {
      const result = await api("/api/admin/inventory");
      if (!form.isConnected) return;
      snapshot = result.snapshot;
      render(); status("เลือกไฟล์เพื่อดูตัวอย่างก่อนบันทึก");
    } catch (error) { if (form.isConnected) status(error.message, true); }
    finally { file.disabled = false; }
  };
  file.addEventListener("change", async () => {
    const selected = file.files[0];
    const current = ++selection;
    preview = null; page = 1; render();
    if (!selected) { status("เลือกไฟล์เพื่อดูตัวอย่างก่อนบันทึก"); return; }
    status("กำลังอ่านไฟล์…");
    try {
      if (!/\.xlsx$/i.test(selected.name)) throw new Error("กรุณาเลือกไฟล์ .xlsx");
      if (selected.size > 5_000_000) throw new Error("ไฟล์ Excel ต้องมีขนาดไม่เกิน 5 MB");
      if (!window.XLSX) throw new Error("ยังโหลดตัวอ่าน Excel ไม่สำเร็จ กรุณาลองอีกครั้ง");
      const buffer = await selected.arrayBuffer();
      if (!form.isConnected || current !== selection) return;
      preview = { filename: selected.name, ...parseInventoryWorkbook(window.XLSX, buffer) };
      if (new Blob([JSON.stringify(preview)]).size > 1_500_000) {
        preview = null;
        throw new Error("ข้อมูลในไฟล์มีขนาดใหญ่เกินไปสำหรับบันทึก กรุณาลดจำนวนรายการใน Excel");
      }
      render(); status("ตรวจยอดแล้วกด “บันทึกเป็นชุดล่าสุด” เพื่อให้ผู้ดูแลคนอื่นเห็นข้อมูลชุดนี้");
    } catch (error) {
      if (!form.isConnected || current !== selection) return;
      file.value = ""; status(error.message || "ไม่สามารถอ่านไฟล์ Excel ได้", true);
    }
  });
  discard.addEventListener("click", () => { selection += 1; preview = null; file.value = ""; page = 1; render(); status("ยกเลิกตัวอย่างแล้ว"); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!preview || save.disabled) return;
    save.disabled = file.disabled = discard.disabled = true;
    status("กำลังบันทึกข้อมูล…");
    try {
      const saved = await api("/api/admin/inventory", { method: "PUT", body: JSON.stringify(preview) });
      if (!form.isConnected) return;
      snapshot = { ...preview, ...saved }; preview = null; file.value = ""; page = 1;
      render(); status("บันทึกชุด Inventory ล่าสุดแล้ว");
    } catch (error) { if (form.isConnected) status(error.message, true); }
    finally { file.disabled = discard.disabled = false; save.disabled = !preview; }
  });
  void load();
}
