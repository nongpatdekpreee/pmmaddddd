/**
 * คลัง / In-store pool: ใช้ชื่อบริษัทใน `sites.Name` เป็นตัวกำหนด (ไม่ fix Sid/SLid)
 * รองรับหลาย Sid ที่ชื่อตรงกัน (เช่น ต่างแค่ตัวพิมพ์) ผ่านเงื่อนไข LOWER(TRIM(Name))
 * ถ้าแก้ค่านี้ ให้ sync กับ client/lib/inStoreSite.ts (ชื่อคลังใน MA UI/CSV)
 */
const DEFAULT_IN_STORE_SITE_NAME = 'บริษัท ที.ซี.ซี.เทคโนโลยี จำกัด Bangna';

/**
 * Location2 ใช้เฉพาะตอน auto-provision แถวคลังถ้ายังไม่มี sites_location
 * ไม่ใช้กรองรายการเครื่องทดแทน — pool = ทุก lid / SLid ใต้ site บางนา + In Store
 */
const DEFAULT_IN_STORE_WAREHOUSE_LOCATION = 'Bangna';

let cachedDefaultInStoreSlid = null;
let cacheAt = 0;
const CACHE_MS = 5 * 60 * 1000;

function slugFromName(text) {
  if (!text) return 'site';
  const s = String(text)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .slice(0, 90);
  return s || 'site';
}

/**
 * SLid ทุกแถว sites_location ใต้ site คลัง Bangna (ทุก lid) — ไม่กรองชื่อ location
 * @returns {Promise<number[]>}
 */
async function resolveAllInStoreSlids(dbOrConn) {
  const [rows] = await dbOrConn.execute(
    `SELECT sl.SLid
     FROM sites_location sl
     INNER JOIN sites s ON sl.Sid = s.Sid
     WHERE LOWER(TRIM(s.Name)) = LOWER(TRIM(?))
     ORDER BY sl.SLid ASC`,
    [DEFAULT_IN_STORE_SITE_NAME]
  );
  return (rows || [])
    .map((r) => parseInt(r.SLid, 10))
    .filter((n) => !Number.isNaN(n) && n > 0);
}

/**
 * SLid แรกของ sites_location ใต้ site คลัง (ORDER BY SLid) — ใช้ตอนย้ายเครื่องกลับคลังเท่านั้น
 * @returns {Promise<number|null>}
 */
async function resolveDefaultInStoreSlid(dbOrConn, { refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cachedDefaultInStoreSlid != null && now - cacheAt < CACHE_MS) {
    return cachedDefaultInStoreSlid;
  }
  const [rows] = await dbOrConn.execute(
    `SELECT sl.SLid
     FROM sites_location sl
     INNER JOIN sites s ON sl.Sid = s.Sid
     WHERE LOWER(TRIM(s.Name)) = LOWER(TRIM(?))
     ORDER BY sl.SLid ASC
     LIMIT 1`,
    [DEFAULT_IN_STORE_SITE_NAME]
  );
  const raw = rows[0]?.SLid;
  const slid = raw != null ? parseInt(raw, 10) : NaN;
  cachedDefaultInStoreSlid = Number.isNaN(slid) ? null : slid;
  cacheAt = now;
  return cachedDefaultInStoreSlid;
}

/** สร้าง sites + location + sites_location สำหรับคลัง Bangna ถ้ายังไม่มี */
async function ensureDefaultInStoreWarehouseSlid(dbOrConn) {
  cachedDefaultInStoreSlid = null;
  let slid = await resolveDefaultInStoreSlid(dbOrConn, { refresh: true });
  if (slid != null) return slid;

  let sid;
  const [siteRows] = await dbOrConn.execute(
    `SELECT Sid FROM sites WHERE LOWER(TRIM(Name)) = LOWER(TRIM(?)) LIMIT 1`,
    [DEFAULT_IN_STORE_SITE_NAME]
  );
  if (siteRows[0]?.Sid != null) {
    sid = parseInt(siteRows[0].Sid, 10);
  } else {
    const [siteIns] = await dbOrConn.execute(
      'INSERT INTO sites (Name, Slug, Status) VALUES (?, ?, ?)',
      [DEFAULT_IN_STORE_SITE_NAME, slugFromName(DEFAULT_IN_STORE_SITE_NAME), 'Active']
    );
    sid = siteIns.insertId;
  }
  if (sid == null || Number.isNaN(Number(sid))) {
    throw new Error(`Failed to provision in-store site "${DEFAULT_IN_STORE_SITE_NAME}"`);
  }

  let lid;
  const [locRows] = await dbOrConn.execute(
    `SELECT lid FROM location WHERE LOWER(TRIM(Location2)) = LOWER(TRIM(?)) LIMIT 1`,
    [DEFAULT_IN_STORE_WAREHOUSE_LOCATION]
  );
  if (locRows[0]?.lid != null) {
    lid = parseInt(locRows[0].lid, 10);
  } else {
    const [locIns] = await dbOrConn.execute('INSERT INTO location (Location2) VALUES (?)', [
      DEFAULT_IN_STORE_WAREHOUSE_LOCATION,
    ]);
    lid = locIns.insertId;
  }
  if (lid == null || Number.isNaN(Number(lid))) {
    throw new Error(`Failed to provision in-store location "${DEFAULT_IN_STORE_WAREHOUSE_LOCATION}"`);
  }

  const [slRows] = await dbOrConn.execute(
    'SELECT SLid FROM sites_location WHERE Sid = ? AND lid = ? LIMIT 1',
    [sid, lid]
  );
  if (slRows[0]?.SLid != null) {
    slid = parseInt(slRows[0].SLid, 10);
  } else {
    const [slIns] = await dbOrConn.execute('INSERT INTO sites_location (Sid, lid) VALUES (?, ?)', [
      sid,
      lid,
    ]);
    slid = slIns.insertId;
  }
  if (slid == null || Number.isNaN(Number(slid))) {
    throw new Error(
      `Failed to provision sites_location for in-store warehouse "${DEFAULT_IN_STORE_SITE_NAME}"`
    );
  }

  cachedDefaultInStoreSlid = slid;
  cacheAt = Date.now();
  console.info(
    `[inStoreSite] Auto-provisioned warehouse SLid=${slid} (site="${DEFAULT_IN_STORE_SITE_NAME}", location="${DEFAULT_IN_STORE_WAREHOUSE_LOCATION}")`
  );
  return slid;
}

/** ย้าย device กลับคลัง — เฉพาะ SLid ใต้ site บริษัท ที.ซี.ซี.เทคโนโลยี จำกัด Bangna เท่านั้น */
async function assignDeviceToInStoreWarehouse(dbOrConn, deviceId) {
  const did = parseInt(deviceId, 10);
  if (Number.isNaN(did)) {
    throw new Error(`Invalid device id for in-store warehouse assignment: ${deviceId}`);
  }
  let slid = await resolveDefaultInStoreSlid(dbOrConn);
  if (slid == null) {
    slid = await ensureDefaultInStoreWarehouseSlid(dbOrConn);
  }
  await dbOrConn.execute('UPDATE devices SET SLid = ? WHERE Did = ?', [slid, did]);
}

module.exports = {
  DEFAULT_IN_STORE_SITE_NAME,
  DEFAULT_IN_STORE_WAREHOUSE_LOCATION,
  resolveAllInStoreSlids,
  resolveDefaultInStoreSlid,
  ensureDefaultInStoreWarehouseSlid,
  assignDeviceToInStoreWarehouse,
};
