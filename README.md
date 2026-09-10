# JIB Pre-order Portal

ระบบจองสินค้าสำหรับสาขา พร้อมหลังบ้านส่วนกลาง บน Cloudflare Workers และ D1

## ความสามารถ

- นำเข้าข้อมูลสาขา 22 สาขาไว้ในฐานข้อมูลแล้ว
- Setup ครั้งแรกสร้างบัญชี `ADMIN` และบัญชีสาขา `BR{รหัสสาข}`
- ผู้ดูแลเพิ่ม แก้ไข ปิดชั่วคราว และเลิกใช้งาน Part ได้
- นำเข้า Part จาก Excel ที่มี `Product`, `Product Name`, `Sell Price`
- สร้างรอบจอง เลือก Part ที่เข้าร่วม และเปิดหรือปิดรอบ
- สาขาเลือกสินค้า ส่งคำขอ และดูสถานะของตัวเอง
- ผู้ดูแลดูทุกใบจองและจัดสรรสินค้าเต็มจำนวนหรือบางส่วนได้
- เก็บข้อมูล Part และราคาตามเวลาที่สาขาจอง เพื่อรักษาประวัติ

## Deploy

1. ติดตั้ง dependencies: `npm install`
2. เข้าสู่ระบบ Cloudflare: `npx wrangler login`
3. สร้างฐานข้อมูล: `npx wrangler d1 create jib-preorder`
4. นำ `database_id` ที่ได้มาแทน `REPLACE_WITH_D1_DATABASE_ID` ใน `wrangler.jsonc`
5. deploy Worker: `npm run deploy`
6. รัน migration จริง: `npm run db:remote`

หลังเปิดเว็บครั้งแรก ให้กรอกรหัสผ่านผู้ดูแลและรหัสผ่านเริ่มต้นของสาขาในหน้า Setup. ไม่ควรส่งรหัสผ่านผ่านแชตหรือเก็บไว้ใน Git.

## Local development

```sh
npm run db:local
npm run dev
```

เปิด `http://127.0.0.1:8787`
