const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { computeDownTimeTotalHours } = require('../utils/downtimeHours');
const { notifyTeamsPlanCreated, notifyTeamsPlanUpdated } = require('../services/teamsPlanNotification');
const { getTeamsActor } = require('../utils/teamsActor');
const { collectTaskChanges } = require('../utils/taskChangeSummary');
const { MA_BROKEN_DEVICE_ASSET_STATE_SET } = require('../config/maBrokenAssetState');
const { assignDeviceToInStoreWarehouse } = require('../config/inStoreSite');
const { resolveTaskContractJoin, resolveTaskSiteLocationSql } = require('../lib/taskContractJoin');
const {
  tenantTaskFilter,
  isTaskVisibleToTenant,
  isSlidVisibleToTenant,
  ownerForManualDevice,
} = require('../utils/tenantScope');

// app_db tasks: id, task_type, contract_id, assets, replacement_device_id, site_id, site_name,
// vendor_name, coverage_scope, start_date, end_date, engineers, asset_binding,
// status, actually_went, notes, reschedule_note, photos, created_at, updated_at

const taskColumnExistsCache = new Map();
const taskColumnExists = async (columnName) => {
  if (taskColumnExistsCache.has(columnName)) {
    return taskColumnExistsCache.get(columnName);
  }
  try {
    const [rows] = await db.execute('SHOW COLUMNS FROM tasks LIKE ?', [columnName]);
    const exists = Array.isArray(rows) && rows.length > 0;
    taskColumnExistsCache.set(columnName, exists);
    return exists;
  } catch (error) {
    console.warn(`[taskColumnExists] cannot inspect column "${columnName}":`, error.message);
    taskColumnExistsCache.set(columnName, false);
    return false;
  }
};

/**
 * MA ไม่ใช้ duration; บางฐานข้อมูลกำหนด `duration` เป็น NOT NULL
 * ใช้ 0 — รองรับทั้ง INT NOT NULL และ VARCHAR (เก็บเป็น '0')
 */
const durationValueForTask = (taskType, duration) => {
  if (String(taskType || '').toUpperCase() === 'MA') return 0;
  if (duration == null || duration === '') return null;
  return duration;
};

/** แปลง HH:mm หรือ HH:mm:ss ให้เป็นรูปแบบ TIME ของ MySQL */
function normalizeMysqlTime(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = String(Math.min(23, Math.max(0, parseInt(m[1], 10)))).padStart(2, '0');
  const mi = String(Math.min(59, Math.max(0, parseInt(m[2], 10)))).padStart(2, '0');
  const ss = m[3] != null ? String(Math.min(59, Math.max(0, parseInt(m[3], 10)))).padStart(2, '0') : '00';
  return `${hh}:${mi}:${ss}`;
}

/** ชื่อคอลัมน์จริงใน DB — ใหม่ก่อน (downtime_* / uptime_*) แล้ว fallback legacy down_time_* (เว้นวรรคก่อน / ไม่ให้ลำดับ * กับ / ติดกันในคอมเมนต์) */
async function resolveDowntimeDateCol() {
  if (await taskColumnExists('downtime_date')) return 'downtime_date';
  if (await taskColumnExists('down_time_start_date')) return 'down_time_start_date';
  return null;
}
async function resolveDowntimeTimeCol() {
  if (await taskColumnExists('downtime_time')) return 'downtime_time';
  if (await taskColumnExists('down_time_start_time')) return 'down_time_start_time';
  return null;
}
async function resolveUptimeDateCol() {
  if (await taskColumnExists('uptime_date')) return 'uptime_date';
  if (await taskColumnExists('down_time_end_date')) return 'down_time_end_date';
  return null;
}
async function resolveUptimeTimeCol() {
  if (await taskColumnExists('uptime_time')) return 'uptime_time';
  if (await taskColumnExists('down_time_end_time')) return 'down_time_end_time';
  return null;
}

function parseDowntimeFieldsFromBody(body) {
  const b = body || {};
  return {
    downtimeDate:
      b.downtimeDate ?? b.downTimeStartDate ?? b.downtime_date ?? b.down_time_start_date,
    downtimeTime:
      b.downtimeTime ?? b.downTimeStartTime ?? b.downtime_time ?? b.down_time_start_time,
    uptimeDate: b.uptimeDate ?? b.downTimeEndDate ?? b.uptime_date ?? b.down_time_end_date,
    uptimeTime: b.uptimeTime ?? b.downTimeEndTime ?? b.uptime_time ?? b.down_time_end_time,
  };
}

/** PATCH: อัปเดตเฉพาะฟิลด์ที่ส่งมา (รองรับทั้งชื่อใหม่และ legacy) */
function parseDowntimePatch(body) {
  const b = body || {};
  const o = {};
  if (
    'downtimeDate' in b ||
    'downTimeStartDate' in b ||
    'downtime_date' in b ||
    'down_time_start_date' in b
  ) {
    o.downtimeDate =
      b.downtimeDate ?? b.downTimeStartDate ?? b.downtime_date ?? b.down_time_start_date ?? null;
  }
  if (
    'downtimeTime' in b ||
    'downTimeStartTime' in b ||
    'downtime_time' in b ||
    'down_time_start_time' in b
  ) {
    o.downtimeTime =
      b.downtimeTime ?? b.downTimeStartTime ?? b.downtime_time ?? b.down_time_start_time ?? null;
  }
  if ('uptimeDate' in b || 'downTimeEndDate' in b || 'uptime_date' in b || 'down_time_end_date' in b) {
    o.uptimeDate = b.uptimeDate ?? b.downTimeEndDate ?? b.uptime_date ?? b.down_time_end_date ?? null;
  }
  if ('uptimeTime' in b || 'downTimeEndTime' in b || 'uptime_time' in b || 'down_time_end_time' in b) {
    o.uptimeTime = b.uptimeTime ?? b.downTimeEndTime ?? b.uptime_time ?? b.down_time_end_time ?? null;
  }
  return o;
}

/** Reason for in process เก็บใน notes เมื่อ status = working — จำกัดความยาว */
const WORKING_NOTES_MAX_LEN = 120;
function clampNotesForWorkingStatus(notes, status) {
  if (notes === null || notes === undefined || notes === '') return null;
  const s = String(notes);
  if (String(status || '').toLowerCase() !== 'working') return s;
  return s.length > WORKING_NOTES_MAX_LEN ? s.slice(0, WORKING_NOTES_MAX_LEN) : s;
}

// Helper function - สร้าง task id ถัดไปโดยอัตโนมัติ (ใช้เลขที่ว่างก่อน)
const generateNextTaskId = async () => {
  try {
    // ดึง id ทั้งหมดจาก database
    const sql = `SELECT id FROM tasks ORDER BY id DESC`;
    const [rows] = await db.execute(sql);
    
    if (rows.length === 0) {
      // ถ้ายังไม่มีข้อมูลเลย ให้เริ่มที่ 1
      return 1;
    }
    
    // แปลง id ทั้งหมดเป็นตัวเลขและเก็บไว้ใน array
    const numericIds = [];
    for (const row of rows) {
      const taskId = row.id;
      // id เป็น INT แล้ว
      if (taskId != null && !isNaN(taskId)) {
        const num = parseInt(taskId, 10);
        if (!isNaN(num)) {
          numericIds.push(num);
        }
      }
    }
    
    if (numericIds.length === 0) {
      // ถ้าไม่มี id ที่เป็นตัวเลขเลย ให้เริ่มที่ 1
      return 1;
    }
    
    // เรียงลำดับตัวเลขจากน้อยไปมาก
    numericIds.sort((a, b) => a - b);
    
    // หาเลขที่ว่างที่น้อยที่สุด (gap filling)
    // เริ่มจาก 1 ไปจนถึง max + 1
    const maxId = Math.max(...numericIds);
    
    // สร้าง Set เพื่อหาง่ายขึ้น
    const idSet = new Set(numericIds);
    
    // หาเลขที่ว่างที่น้อยที่สุด
    for (let i = 1; i <= maxId; i++) {
      if (!idSet.has(i)) {
        console.log(`Found gap: using task id ${i} (max was: ${maxId})`);
        return i;
      }
    }
    
    // ถ้าไม่มีเลขว่างแล้ว ให้ใช้เลขถัดไปจาก max
    const nextId = maxId + 1;
    console.log(`No gaps found: using next task id ${nextId} (max was: ${maxId})`);
    return nextId;
  } catch (error) {
    console.error('Error generating next task id:', error);
    throw error;
  }
};

/** คืนค่า date เป็น string YYYY-MM-DD ตามที่เก็บใน DB (ส่งเป็น string เลย ไม่ให้ JSON serialize เป็น ISO แล้วเลื่อนวัน) */
const toDateOnlyString = (val) => {
  if (val == null) return null;
  if (typeof val === 'string') return val.trim().substring(0, 10) || null;
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = val.getMonth() + 1;
    const d = val.getDate();
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
};

/** แปลง time จาก DB (string / Date) → string HH:mm:ss สำหรับ API */
function downtimeTimeToApiString(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    const hh = String(raw.getUTCHours()).padStart(2, '0');
    const mi = String(raw.getUTCMinutes()).padStart(2, '0');
    const ss = String(raw.getUTCSeconds()).padStart(2, '0');
    return `${hh}:${mi}:${ss}`;
  }
  const s = String(raw).trim();
  if (!s) return null;
  return normalizeMysqlTime(s) || s.slice(0, 8);
}

/** แปลงแถว DB → API fields เดียวกันไม่ว่าจะเก็บในคอลัมน์ใหม่หรือเก่า */
function downtimeApiFieldsFromRow(row) {
  const rawDd = row.downtime_date ?? row.down_time_start_date;
  const rawDt = row.downtime_time ?? row.down_time_start_time;
  const rawUd = row.uptime_date ?? row.down_time_end_date;
  const rawUt = row.uptime_time ?? row.down_time_end_time;
  const rawTot = row.downtime_total_hours ?? row.down_time_total_hours;

  const downtimeDate =
    rawDd != null && String(rawDd).trim() !== '' ? toDateOnlyString(rawDd) : null;
  const downtimeTime = downtimeTimeToApiString(rawDt);
  const uptimeDate =
    rawUd != null && String(rawUd).trim() !== '' ? toDateOnlyString(rawUd) : null;
  const uptimeTime = downtimeTimeToApiString(rawUt);
  let downtimeTotalHours = null;
  if (
    rawTot != null &&
    String(rawTot).trim() !== '' &&
    !Number.isNaN(Number(rawTot))
  ) {
    downtimeTotalHours = Number(rawTot);
  }

  /** MA: ส่ง key ชุดนี้เสมอ (null เมื่อยังไม่กรอก/ยังไม่ migrate) — ให้ client ไม่ต้องเดาว่ามีฟิลด์หรือไม่ */
  if (String(row.task_type || '').toUpperCase() === 'MA') {
    return {
      downtimeDate,
      downtimeTime,
      uptimeDate,
      uptimeTime,
      downtimeTotalHours,
    };
  }

  const out = {};
  if (downtimeDate != null) out.downtimeDate = downtimeDate;
  if (downtimeTime != null) out.downtimeTime = downtimeTime;
  if (uptimeDate != null) out.uptimeDate = uptimeDate;
  if (uptimeTime != null) out.uptimeTime = uptimeTime;
  if (downtimeTotalHours != null) out.downtimeTotalHours = downtimeTotalHours;
  return out;
}

/**
 * MA: uptime ต้องไม่ก่อน downtime เริ่ม — ไม่งั้น computeDownTimeTotalHours ได้ null
 * คืน { date, time } โดย time เป็นรูปแบบที่ normalizeMysqlTime ให้แล้ว
 */
function clampMaUptimeAfterDowntimeStart(existingRow, uptimeDateStr, uptimeTimeSql) {
  if (!uptimeDateStr || !uptimeTimeSql) return { date: uptimeDateStr, time: uptimeTimeSql };
  const sd = toDateOnlyString(existingRow.downtime_date ?? existingRow.down_time_start_date);
  if (!sd) return { date: uptimeDateStr, time: normalizeMysqlTime(uptimeTimeSql) };
  const downT = normalizeMysqlTime(existingRow.downtime_time ?? existingRow.down_time_start_time) || '00:00:00';
  const upT = normalizeMysqlTime(uptimeTimeSql) || '00:00:00';
  const uds = String(uptimeDateStr).trim().slice(0, 10);
  if (uds > sd) return { date: uds, time: upT };
  if (uds < sd) return { date: sd, time: downT };
  if (upT >= downT) return { date: uds, time: upT };
  return { date: sd, time: downT };
}

/** หลัง uptime เปลี่ยน — คำนวณ downtime_total_hours (รองรับชื่อคอลัมน์ใหม่/เก่า) */
async function persistMaDowntimeTotalHoursForTask(taskId) {
  try {
    let [taskRows] = await db.execute('SELECT * FROM tasks WHERE id = ?', [taskId]);
    let tr = taskRows[0];
    if (!tr) return;
    const isMa = String(tr.task_type || '').toUpperCase() === 'MA';
    if (isMa) {
      const ud = toDateOnlyString(tr.uptime_date ?? tr.down_time_end_date);
      const ut = normalizeMysqlTime(tr.uptime_time ?? tr.down_time_end_time);
      if (ud && ut) {
        const c = clampMaUptimeAfterDowntimeStart(tr, ud, ut);
        if (c.date && c.time && (c.date !== ud || c.time !== ut)) {
          const udCol = await resolveUptimeDateCol();
          const utCol = await resolveUptimeTimeCol();
          if (udCol && utCol) {
            try {
              await db.execute(`UPDATE tasks SET ${udCol} = ?, ${utCol} = ? WHERE id = ?`, [c.date, c.time, taskId]);
              const [again] = await db.execute('SELECT * FROM tasks WHERE id = ?', [taskId]);
              if (again[0]) tr = again[0];
            } catch (updErr) {
              console.warn('[persistMaDowntimeTotalHoursForTask] clamp uptime:', updErr.message);
            }
          }
        }
      }
    }
    const hours = computeDownTimeTotalHours(
      tr.downtime_date ?? tr.down_time_start_date,
      tr.uptime_date ?? tr.down_time_end_date,
      tr.uptime_time ?? tr.down_time_end_time,
      tr.downtime_time ?? tr.down_time_start_time
    );
    if (hours == null) {
      try {
        await db.execute('UPDATE tasks SET downtime_total_hours = NULL WHERE id = ?', [taskId]);
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR' || (e.message && e.message.includes('Unknown column'))) {
          await db.execute('UPDATE tasks SET down_time_total_hours = NULL WHERE id = ?', [taskId]).catch(() => {});
        }
      }
      return;
    }
    try {
      await db.execute('UPDATE tasks SET downtime_total_hours = ? WHERE id = ?', [hours, taskId]);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR' || (e.message && e.message.includes('Unknown column'))) {
        await db.execute('UPDATE tasks SET down_time_total_hours = ? WHERE id = ?', [hours, taskId]).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[persistMaDowntimeTotalHoursForTask]', e.message);
  }
}

/** รวบรวม path string จาก tasks.photos / report file_path (array ของ string หรือ { path }) */
function collectPathStringsFromPhotos(photos) {
  if (!photos) return [];
  const arr = Array.isArray(photos) ? photos : [];
  const out = [];
  for (const p of arr) {
    if (typeof p === 'string' && p.trim()) out.push(p.trim());
    else if (p && typeof p === 'object') {
      if (typeof p.path === 'string' && p.path.trim()) out.push(p.path.trim());
      if (typeof p.url === 'string' && p.url.trim()) out.push(p.url.trim());
    }
  }
  return out;
}

function pathListIncludesBasename(pathList, basename) {
  const b = String(basename);
  for (const p of pathList) {
    const s = String(p);
    const last = s.split(/[/\\]/).filter(Boolean).pop();
    if (last === b || s.endsWith(b)) return true;
  }
  return false;
}

function safeParseJsonArray(val) {
  if (val == null) return [];
  try {
    const v = typeof val === 'string' ? JSON.parse(val) : val;
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

/**
 * GET /api/tasks/:taskId/ma-notice/:filename
 * เปิดไฟล์ repair notice ที่เก็บใต้ uploads/reports (ตรงกับ taskMaNoticeUrl ใน client)
 */
const getMaNoticeFile = async (req, res) => {
  try {
    const taskId = parseInt(String(req.params.taskId), 10);
    if (Number.isNaN(taskId) || taskId <= 0) {
      return res.status(400).send('Bad request');
    }
    let rawName = req.params.filename;
    try {
      rawName = decodeURIComponent(rawName);
    } catch (_) {
      /* keep raw */
    }
    const safe = path.basename(String(rawName).replace(/\\/g, '/'));
    if (!safe) {
      return res.status(400).send('Bad request');
    }
    if (safe.includes('..')) {
      return res.status(400).send('Bad request');
    }

    const [taskRows] = await db.execute('SELECT photos FROM tasks WHERE id = ?', [taskId]);
    if (!taskRows.length) {
      return res.status(404).send('Not found');
    }

    const photosParsed = safeParseJsonArray(taskRows[0].photos);
    const fromTask = collectPathStringsFromPhotos(photosParsed);
    let allowed = pathListIncludesBasename(fromTask, safe);

    if (!allowed) {
      const [repRows] = await db.execute(
        'SELECT file_path, image_path FROM report WHERE id = ? LIMIT 50',
        [taskId]
      );
      for (const row of repRows) {
        const fp = safeParseJsonArray(row.file_path);
        const ip = safeParseJsonArray(row.image_path);
        const combined = [...collectPathStringsFromPhotos(fp), ...collectPathStringsFromPhotos(ip)];
        if (pathListIncludesBasename(combined, safe)) {
          allowed = true;
          break;
        }
      }
    }

    if (!allowed) {
      return res.status(404).send('Not found');
    }

    const reportsDir = path.resolve(path.join(__dirname, '..', 'uploads', 'reports'));
    const absFile = path.resolve(path.join(reportsDir, safe));
    const rel = path.relative(reportsDir, absFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(400).send('Bad request');
    }
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
      return res.status(404).send('Not found');
    }

    return res.sendFile(absFile);
  } catch (error) {
    console.error('[getMaNoticeFile]', error);
    return res.status(500).send('Error');
  }
};

/** MA: assigned_service จาก body (camelCase หรือ snake_case) */
const normalizeAssignedServiceFromBody = (body) => {
  const raw = body?.assignedService ?? body?.assigned_service;
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === '') return null;
  return s.length > 255 ? s.slice(0, 255) : s;
};

const mapTaskRow = (row) => {
  const slaVal = row.contract_sla_term;
  const sofRaw = row.contract_sof_name != null ? String(row.contract_sof_name).trim() : '';
  const siteLocation =
    row.site_location != null && String(row.site_location).trim() !== ''
      ? String(row.site_location).trim()
      : null;
  const siteProvince =
    row.site_province != null && String(row.site_province).trim() !== ''
      ? String(row.site_province).trim()
      : null;
  const siteDbName =
    row.site_db_name != null && String(row.site_db_name).trim() !== ''
      ? String(row.site_db_name).trim()
      : null;
  const siteContactRaw = row.site_contact;
  return {
  id: row.id,
  contractId: row.contract_id,
  ...(sofRaw ? { sofName: sofRaw } : {}),
  replacementDeviceId: row.replacement_device_id,
  taskType: row.task_type,
  siteId: row.site_id,
  siteName: row.site_name,
  ...(siteDbName ? { siteDbName } : {}),
  ...(siteLocation ? { location: siteLocation } : {}),
  ...(siteProvince ? { province: siteProvince } : {}),
  ...(siteContactRaw != null && siteContactRaw !== '' ? { siteContact: siteContactRaw } : {}),
  vendorName: row.vendor_name,
  vendorTel: row.vendor_tel,
  reporterName: row.reporter_name,
  reporterTel: row.reporter_tel,
  reporterPosition: row.reporter_position,
  reporterEmail: row.reporter_email,
  ticket: row.ticket,
  rootCause: row.root_cause,
  resolution: row.resolution,
  ...(slaVal != null && slaVal !== '' ? { slaTerm: slaVal } : {}),
  coverageScope: row.coverage_scope,
  startDate: toDateOnlyString(row.start_date),
  endDate: toDateOnlyString(row.end_date),
  // MA: ไม่ส่ง duration — downtime/uptime เก็บแยกจาก duration
  ...(String(row.task_type || '').toUpperCase() !== 'MA' && row.duration !== undefined
    ? { duration: row.duration }
    : {}),
  ...downtimeApiFieldsFromRow(row),
  engineers: row.engineers ? (typeof row.engineers === 'string' ? JSON.parse(row.engineers) : row.engineers) : [],
  assets: row.assets ? (typeof row.assets === 'string' ? JSON.parse(row.assets) : row.assets) : [],
  assetBinding: row.asset_binding,
  status: row.status || 'not-started',
  actuallyWent: !!row.actually_went,
  notes: row.notes,
  rescheduleNote: row.reschedule_note != null ? row.reschedule_note : null,
  photos: row.photos ? (typeof row.photos === 'string' ? JSON.parse(row.photos) : row.photos) : [],
  ...(row.assigned_service !== undefined
    ? {
        assignedService:
          row.assigned_service == null || String(row.assigned_service).trim() === ''
            ? null
            : String(row.assigned_service).trim(),
      }
    : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
};
};

async function buildTaskQueryFragments(existingSiteLocationAlias) {
  const { select: contractSelect, join: contractJoin } = await resolveTaskContractJoin();
  const siteLoc = await resolveTaskSiteLocationSql(
    existingSiteLocationAlias ? { existingSiteLocationAlias } : {},
  );
  return {
    select: `${contractSelect}, ${siteLoc.select}`,
    join: `${contractJoin} ${siteLoc.join}`.trim(),
  };
}

async function buildTaskQueryFragmentsWithSlFilter() {
  const { select: contractSelect, join: contractJoin } = await resolveTaskContractJoin();
  const siteLoc = await resolveTaskSiteLocationSql({ existingSiteLocationAlias: 'sl' });
  return {
    select: `${contractSelect}, ${siteLoc.select}`,
    join: `${contractJoin} LEFT JOIN sites_location sl ON sl.SLid = t.site_id ${siteLoc.join}`.trim(),
  };
}
// devices_history is populated by DB trigger (trg_devices_update)
const updateDeviceAssetState = async (deviceId, newState) => {
  const [current] = await db.execute('SELECT Asset_State FROM devices WHERE Did = ?', [deviceId]);
  if (current.length === 0) throw new Error(`Device ${deviceId} not found`);
  if (current[0].Asset_State !== newState) {
    await db.execute('UPDATE devices SET Asset_State = ? WHERE Did = ?', [newState, deviceId]);
  }
};

/** MA task: map Ticket number to devices.Refer_Ticket เฉพาะเครื่องทดแทน (dropdown replacement) */
const normalizeReferTicket = (ticket) => {
  if (ticket == null) return null;
  const s = String(ticket).trim();
  return s === '' ? null : s;
};

const extractMaReplacementDeviceIdsFromAssets = (assets) => {
  if (!Array.isArray(assets) || assets.length === 0) return [];
  const ids = [];
  for (const a of assets) {
    if (a == null || typeof a !== 'object') continue;
    const raw = a.replacementDeviceId;
    if (raw == null || raw === '') continue;
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (!Number.isNaN(n) && n > 0) ids.push(n);
  }
  return ids;
};

const parsePositiveDeviceId = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
};

/** Did เครื่องทดแทน: assets[].replacementDeviceId + tasks.replacement_device_id (รองรับข้อมูลเก่า) */
const collectMaReplacementReferTicketDeviceIds = (assets, taskReplacementDeviceId) => {
  const fromAssetReplacements = extractMaReplacementDeviceIdsFromAssets(assets);
  const taskRep = parsePositiveDeviceId(taskReplacementDeviceId);
  const merged = [...fromAssetReplacements];
  if (taskRep != null) merged.push(taskRep);
  return [...new Set(merged)];
};

const syncMaReferTicketOnDevices = async (assets, ticket, taskReplacementDeviceId) => {
  const ids = collectMaReplacementReferTicketDeviceIds(assets, taskReplacementDeviceId);
  if (ids.length === 0) return;
  const val = normalizeReferTicket(ticket);
  const placeholders = ids.map(() => '?').join(',');
  await db.execute(
    `UPDATE devices SET Refer_Ticket = ? WHERE Did IN (${placeholders})`,
    [val, ...ids]
  );
};

const extractBrokenDeviceIdFromAsset = (asset) => {
  if (asset == null) return null;
  if (typeof asset === 'number' || typeof asset === 'string') {
    return parsePositiveDeviceId(asset);
  }
  if (typeof asset === 'object') {
    return parsePositiveDeviceId(
      asset.id ?? asset.Did ?? asset.did ?? asset.device_id ?? asset.deviceId
    );
  }
  return null;
};

/** Did ที่ต้องซิงก์ Assigned_Service: เครื่องเสียใน assets + เครื่องทดแทน */
const collectMaAssignedServiceDeviceIds = (assets, taskReplacementDeviceId) => {
  const ids = new Set();
  if (Array.isArray(assets)) {
    for (const a of assets) {
      const brokenId = extractBrokenDeviceIdFromAsset(a);
      if (brokenId != null) ids.add(brokenId);
    }
  }
  for (const id of collectMaReplacementReferTicketDeviceIds(assets, taskReplacementDeviceId)) {
    ids.add(id);
  }
  return [...ids];
};

/** MA: เขียน assigned_service ของงานลง devices.Assigned_Service */
const syncMaAssignedServiceOnDevices = async (assets, assignedService, taskReplacementDeviceId) => {
  const ids = collectMaAssignedServiceDeviceIds(assets, taskReplacementDeviceId);
  if (ids.length === 0) return;
  const raw = assignedService == null ? '' : String(assignedService).trim();
  const val = raw === '' ? null : raw.length > 255 ? raw.slice(0, 255) : raw;
  const placeholders = ids.map(() => '?').join(',');
  await db.execute(
    `UPDATE devices SET Assigned_Service = ? WHERE Did IN (${placeholders})`,
    [val, ...ids]
  );
};

/** อุปกรณ์ที่กรอกเองใน Add Plan MA (ยังไม่มี Did จริงใน devices) */
const isManualMaAsset = (asset) => {
  if (asset == null || typeof asset !== 'object') return false;
  if (String(asset.source || '').toLowerCase() === 'manual') return true;
  const rawId = asset.id ?? asset.Did ?? asset.did;
  if (rawId == null || rawId === '') return false;
  if (typeof rawId === 'string' && rawId.startsWith('manual-')) return true;
  return parsePositiveDeviceId(rawId) == null;
};

const MANUAL_REPLACEMENT_OWNER = 'TCC';

const resolveSiteNameForProjectOwen = async (siteId, fallbackName) => {
  const slid = parsePositiveDeviceId(siteId);
  if (slid != null) {
    try {
      const [rows] = await db.execute(
        `SELECT s.Name AS site_name
         FROM sites_location sl
         INNER JOIN sites s ON s.Sid = sl.Sid
         WHERE sl.SLid = ?
         LIMIT 1`,
        [slid]
      );
      const fromDb = rows[0]?.site_name != null ? String(rows[0].site_name).trim() : '';
      if (fromDb) return fromDb;
    } catch (e) {
      console.warn('[resolveSiteNameForProjectOwen]', e.message);
    }
  }
  const fallback = String(fallbackName || '').trim();
  if (!fallback) return '';
  // tasks.site_name อาจเป็น "Site - Location" — ใช้เฉพาะชื่อ site ด้านหน้า
  return fallback.split(' - ')[0].trim() || fallback;
};

/**
 * INSERT/UPDATE devices สำหรับ manual MA assets ก่อนบันทึก task
 * — broken: In Use ที่ site ของงานก่อน พอ Done ค่อยเปลี่ยน Asset_State + ย้าย site
 * — replacement: In Store ที่คลังก่อน พอ Done ค่อย In Use + ย้ายไป site งาน
 */
const insertOrUpdateManualDeviceRow = async (deviceLike, { siteId, contractId, initialAssetState, ownerOverride }) => {
  const name = String(deviceLike.name ?? deviceLike.CI_Name ?? '').trim();
  if (!name) {
    throw new Error('Manual device requires a name (CI_Name)');
  }

  const serial =
    (deviceLike.serialNumber != null && String(deviceLike.serialNumber).trim()) ||
    (deviceLike.serial != null && String(deviceLike.serial).trim()) ||
    null;
  if (!serial) {
    throw new Error('Manual device requires a serial number');
  }
  const assetNumber =
    (deviceLike.assetNumber != null && String(deviceLike.assetNumber).trim()) ||
    (deviceLike.Asset_Number != null && String(deviceLike.Asset_Number).trim()) ||
    null;
  const slid =
    parsePositiveDeviceId(deviceLike.SLid) ??
    parsePositiveDeviceId(siteId);
  const dtypeid = parsePositiveDeviceId(deviceLike.Dtypeid);
  const deroleid = parsePositiveDeviceId(deviceLike.DeRoleid);
  const owner = String(
    ownerOverride ??
      deviceLike.Owner ??
      deviceLike.owner ??
      deviceLike.Project_Owen ??
      deviceLike.projectOwen ??
      ''
  ).trim();
  if (!owner) {
    throw new Error('Manual device requires Owner');
  }
  const cid =
    parsePositiveDeviceId(deviceLike.contract_id) ??
    parsePositiveDeviceId(contractId);
  const assetState = initialAssetState || 'In Use';

  let did = null;

  if (assetNumber) {
    const [existingRows] = await db.execute(
      'SELECT Did FROM devices WHERE Asset_Number = ? LIMIT 1',
      [assetNumber]
    );
    if (existingRows[0]?.Did != null) {
      did = parsePositiveDeviceId(existingRows[0].Did);
      await db.execute(
        `UPDATE devices
         SET CI_Name = ?,
             serial = COALESCE(?, serial),
             SLid = COALESCE(?, SLid),
             Asset_State = COALESCE(NULLIF(TRIM(Asset_State), ''), ?),
             Dtypeid = COALESCE(?, Dtypeid),
             DeRoleid = COALESCE(?, DeRoleid),
             Owner = ?
         WHERE Did = ?`,
        [name, serial, slid, assetState, dtypeid, deroleid, owner, did]
      );
    }
  }

  if (did == null) {
    const [insertResult] = await db.execute(
      `INSERT INTO devices (
        Asset_State, serial, CI_Name, Asset_Number, SLid, Dtypeid, DeRoleid, Owner
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [assetState, serial, name, assetNumber, slid, dtypeid, deroleid, owner]
    );
    did = parsePositiveDeviceId(insertResult.insertId);
  }

  if (did == null) {
    throw new Error(`Failed to persist manual device "${name}"`);
  }

  return {
    did,
    name,
    serial,
    assetNumber,
    slid,
    dtypeid,
    deroleid,
    owner,
    cid,
  };
};

const persistManualMaAssets = async (assets, { siteId, contractId, siteName, tenant } = {}) => {
  if (!Array.isArray(assets) || assets.length === 0) return assets;

  const brokenOwner = await resolveSiteNameForProjectOwen(siteId, siteName);
  const resolved = [];
  for (const asset of assets) {
    let nextAsset = asset;

    if (isManualMaAsset(asset)) {
      const owner = ownerForManualDevice(tenant, brokenOwner);
      if (!owner) {
        throw new Error('Manual broken device requires site name for Owner');
      }
      const saved = await insertOrUpdateManualDeviceRow(asset, {
        siteId,
        contractId,
        initialAssetState: 'In Use',
        ownerOverride: owner,
      });
      nextAsset = {
        ...asset,
        id: saved.did,
        Did: saved.did,
        name: saved.name,
        CI_Name: saved.name,
        serialNumber: saved.serial || undefined,
        serial: saved.serial || undefined,
        assetNumber: saved.assetNumber || undefined,
        Asset_Number: saved.assetNumber || undefined,
        SLid: saved.slid ?? asset.SLid,
        Dtypeid: saved.dtypeid ?? asset.Dtypeid,
        DeRoleid: saved.deroleid ?? asset.DeRoleid,
        Owner: saved.owner,
        contract_id: saved.cid ?? asset.contract_id,
        source: 'manual',
      };
    }

    const nestedRep =
      nextAsset && typeof nextAsset === 'object' ? nextAsset.replacementDevice : null;
    if (nestedRep && isManualMaAsset(nestedRep)) {
      // เครื่องทดแทนที่กรอกเอง — เริ่มที่ In Store (ยังไม่อยู่ที่ site งานจนกว่า Done)
      let warehouseSlid = null;
      try {
        warehouseSlid = await require('../config/inStoreSite').resolveDefaultInStoreSlid(db);
        if (warehouseSlid == null) {
          warehouseSlid = await require('../config/inStoreSite').ensureDefaultInStoreWarehouseSlid(db);
        }
      } catch (e) {
        console.warn('[persistManualMaAssets] resolve warehouse SLid:', e.message);
      }
      const savedRep = await insertOrUpdateManualDeviceRow(
        { ...nestedRep, SLid: nestedRep.SLid ?? warehouseSlid },
        {
          siteId: warehouseSlid ?? siteId,
          contractId,
          initialAssetState: 'In Store',
          ownerOverride: ownerForManualDevice(tenant, MANUAL_REPLACEMENT_OWNER),
        }
      );
      const { replacementDevice: _omitRep, ...rest } = nextAsset;
      nextAsset = {
        ...rest,
        replacementDeviceId: savedRep.did,
      };
    }

    resolved.push(nextAsset);
  }
  return resolved;
};

const resolveMaBrokenAssetStateForDone = (asset) => {
  const rawState = asset?.brokenAssetState ?? asset?.broken_asset_state;
  const state = rawState != null ? String(rawState).trim() : '';
  if (MA_BROKEN_DEVICE_ASSET_STATE_SET.has(state)) return state;
  return 'In Store';
};

/** MA: อัปเดต Asset_State อุปกรณ์ที่เสียเมื่อกด Done เท่านั้น (ใช้ brokenAssetState จาก assets) */
const applyMaBrokenAssetStatesOnDone = async (assets) => {
  if (!Array.isArray(assets) || assets.length === 0) return;
  for (const asset of assets) {
    if (asset == null || typeof asset !== 'object') continue;
    const deviceId = extractBrokenDeviceIdFromAsset(asset);
    if (!deviceId) {
      console.warn('[applyMaBrokenAssetStatesOnDone] skip asset without device id:', asset);
      continue;
    }
    const state = resolveMaBrokenAssetStateForDone(asset);
    await updateDeviceAssetState(deviceId, state);
    if (state === 'In Store') {
      await assignDeviceToInStoreWarehouse(db, deviceId);
    }
  }
};

// POST /api/tasks
const createTask = async (req, res) => {
  try {
    const {
      taskType,
      contractId,
      replacementDeviceId,
      siteId,
      siteName,
      vendorName,
      vendorTel,
      reporterName,
      reporterTel,
      reporterPosition,
      reporterEmail,
      ticket,
      rootCause,
      resolution,
      duration,
      coverageScope,
      startDate,
      endDate,
      engineers = [],
      assets = [],
      assetBinding,
      status = 'not-started',
      actuallyWent = false,
      notes = null,
      rescheduleNote = null,
      photos = [],
    } = req.body;

    const { downtimeDate, downtimeTime, uptimeDate, uptimeTime } = parseDowntimeFieldsFromBody(req.body);

    if (!taskType || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Please specify taskType, startDate, endDate',
      });
    }

    // สร้าง task id ใหม่โดยอัตโนมัติ (ใช้เลขที่ว่างก่อน)
    const newTaskId = await generateNextTaskId();
    
    // ตรวจสอบว่า task id นี้มีอยู่แล้วหรือไม่ (ป้องกัน race condition)
    const checkSql = `SELECT id FROM tasks WHERE id = ?`;
    const [existing] = await db.execute(checkSql, [newTaskId]);
    
    let finalTaskId = newTaskId;
    if (existing.length > 0) {
      // ถ้ามีแล้ว (อาจเกิดจาก race condition) ให้ลองหาใหม่
      finalTaskId = await generateNextTaskId();
      const [retryExisting] = await db.execute(checkSql, [finalTaskId]);
      if (retryExisting.length > 0) {
        throw new Error('Cannot create task id that does not exist, please try again');
      }
    }

    const safeParseInt = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
      return isNaN(parsed) ? null : parsed;
    };

    const createContractSlid = safeParseInt(contractId);
    const createSiteSlid = safeParseInt(siteId);
    if (createContractSlid && !(await isSlidVisibleToTenant(createContractSlid, req.user && req.user.tenant))) {
      return res.status(404).json({ success: false, message: 'Contract not found' });
    }
    if (createSiteSlid && !(await isSlidVisibleToTenant(createSiteSlid, req.user && req.user.tenant))) {
      return res.status(404).json({ success: false, message: 'Site not found' });
    }

    /** MA: ถ้ามีอุปกรณ์ที่กรอกเอง → INSERT ลง devices ก่อน แล้วเก็บ Did จริงใน assets */
    let assetsToSave = Array.isArray(assets) ? assets : [];
    if (String(taskType || '').toUpperCase() === 'MA' && assetsToSave.length > 0) {
      try {
        assetsToSave = await persistManualMaAssets(assetsToSave, {
          siteId: safeParseInt(siteId),
          contractId: safeParseInt(contractId),
          siteName: siteName || null,
          tenant: req.user && req.user.tenant,
        });
      } catch (persistErr) {
        console.error('[createTask] persistManualMaAssets:', persistErr);
        return res.status(400).json({
          success: false,
          message: persistErr.message || 'Failed to save manual device to database',
        });
      }
    }

    let replacementIdToSave = safeParseInt(replacementDeviceId);
    if (
      replacementIdToSave == null &&
      assetsToSave[0] &&
      typeof assetsToSave[0] === 'object'
    ) {
      replacementIdToSave = safeParseInt(assetsToSave[0].replacementDeviceId);
    }

    const insertColumns = [
      'id', 'task_type', 'contract_id', 'replacement_device_id', 'site_id', 'site_name', 'vendor_name', 'vendor_tel',
      'reporter_name', 'reporter_tel', 'ticket', 'root_cause', 'resolution', 'coverage_scope',
      'start_date', 'end_date', 'engineers', 'assets', 'asset_binding', 'status', 'actually_went',
      'notes', 'reschedule_note', 'photos',
    ];
    const insertValues = [
      finalTaskId,
      taskType,
      safeParseInt(contractId),
      replacementIdToSave,
      safeParseInt(siteId),
      siteName || null,
      vendorName || null,
      vendorTel || null,
      reporterName || null,
      reporterTel || null,
      ticket || null,
      rootCause || null,
      resolution || null,
      coverageScope || null,
      startDate,
      endDate,
      (engineers && Array.isArray(engineers) && engineers.length > 0) ? JSON.stringify(engineers) : null,
      (assetsToSave && Array.isArray(assetsToSave) && assetsToSave.length > 0) ? JSON.stringify(assetsToSave) : null,
      assetBinding || null,
      status || 'not-started',
      actuallyWent ? 1 : 0,
      clampNotesForWorkingStatus(notes, status || 'not-started'),
      rescheduleNote || null,
      photos && Array.isArray(photos) && photos.length > 0 ? JSON.stringify(photos) : null,
    ];
    if (await taskColumnExists('duration')) {
      insertColumns.push('duration');
      insertValues.push(durationValueForTask(taskType, duration));
    }
    const ddCol = await resolveDowntimeDateCol();
    if (ddCol) {
      insertColumns.push(ddCol);
      insertValues.push(downtimeDate || null);
    }
    const dtCol = await resolveDowntimeTimeCol();
    if (dtCol) {
      insertColumns.push(dtCol);
      insertValues.push(normalizeMysqlTime(downtimeTime));
    }
    const isMaCreate = String(taskType || '').toUpperCase() === 'MA';
    const hasDowntimeInPayload =
      (downtimeDate != null && String(downtimeDate).trim() !== '') ||
      (downtimeTime != null && String(downtimeTime).trim() !== '');
    if (isMaCreate && hasDowntimeInPayload && (!ddCol || !dtCol)) {
      console.warn(
        '[createTask] MA downtime ไม่ถูกบันทึก: ตาราง tasks ยังไม่มีคอลัมน์ downtime — รัน migrations/add_tasks_ma_downtime.sql แล้ว restart server',
        { taskId: finalTaskId, ddCol, dtCol }
      );
    }
    /** uptime — ใส่ตอนส่ง MA report; ตอนสร้างงานไม่ใส่คอลัมน์ถ้ายังไม่มีค่า */
    const endDateStr =
      uptimeDate != null && String(uptimeDate).trim()
        ? String(uptimeDate).trim().slice(0, 10)
        : null;
    const endTimeNorm = normalizeMysqlTime(uptimeTime);
    const udCol = await resolveUptimeDateCol();
    if (udCol && endDateStr) {
      insertColumns.push(udCol);
      insertValues.push(endDateStr);
    }
    const utCol = await resolveUptimeTimeCol();
    if (utCol && endTimeNorm) {
      insertColumns.push(utCol);
      insertValues.push(endTimeNorm);
    }
    const assignedServiceForCreate =
      String(taskType || '').toUpperCase() === 'MA'
        ? normalizeAssignedServiceFromBody(req.body)
        : null;
    if (await taskColumnExists('assigned_service')) {
      insertColumns.push('assigned_service');
      insertValues.push(assignedServiceForCreate);
    }
    if (await taskColumnExists('reporter_position')) {
      insertColumns.push('reporter_position');
      insertValues.push(
        String(taskType || '').toUpperCase() === 'MA' && reporterPosition
          ? String(reporterPosition).trim() || null
          : null
      );
    }
    if (await taskColumnExists('reporter_email')) {
      insertColumns.push('reporter_email');
      insertValues.push(
        String(taskType || '').toUpperCase() === 'MA' && reporterEmail
          ? String(reporterEmail).trim() || null
          : null
      );
    }
    const insertSql = `INSERT INTO tasks (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`;

    await db.execute(insertSql, insertValues);

    // MA: Asset_State อุปกรณ์ที่เสียจะอัปเดตเมื่อกด Done เท่านั้น
    if (String(taskType || '').toUpperCase() === 'MA') {
      await syncMaReferTicketOnDevices(assetsToSave, ticket, replacementIdToSave);
      await syncMaAssignedServiceOnDevices(
        assetsToSave,
        assignedServiceForCreate,
        replacementIdToSave
      );
    }

    const { select, join } = await buildTaskQueryFragments();
    const [rows] = await db.execute(
      `SELECT t.*, ${select}
       FROM tasks t ${join} WHERE t.id = ?`,
      [finalTaskId]
    );
    const createdTask = mapTaskRow(rows[0]);

    notifyTeamsPlanCreated(createdTask, { actor: getTeamsActor(req.user) }).catch((err) => {
      console.error('[createTask] Teams notification failed:', err?.message || err);
    });

    return res.status(201).json({
      success: true,
      message: 'สร้าง Task สำเร็จ',
      data: createdTask,
    });
  } catch (error) {
    console.error('Error creating task:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', JSON.stringify(req.body, null, 2));
    res.status(500).json({
      success: false,
      message: 'Error creating task',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};

// GET /api/tasks
const getTasks = async (req, res) => {
  try {
    const { select, join } = await buildTaskQueryFragments();
    const monthRaw = req.query?.month;
    const yearRaw = req.query?.year;
    const month = monthRaw != null && monthRaw !== '' ? Number(monthRaw) : null;
    const year = yearRaw != null && yearRaw !== '' ? Number(yearRaw) : null;
    const useMonthFilter =
      Number.isInteger(month) &&
      month >= 1 &&
      month <= 12 &&
      Number.isInteger(year) &&
      year >= 2000 &&
      year <= 2100;

    let sql = `SELECT t.*, ${select}
       FROM tasks t
       ${join}`;
    const params = [];
    if (useMonthFilter) {
      // รวมงานที่ทับเดือนที่ขอ (start หรือ end อยู่ในเดือน / คร่อมเดือน)
      const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const monthEndExclusive = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
      sql += ` WHERE t.start_date < ? AND (t.end_date IS NULL OR t.end_date >= ?)`;
      params.push(monthEndExclusive, monthStart);
    }
    const tf = tenantTaskFilter(req.user && req.user.tenant, 't');
    sql += useMonthFilter ? tf.sql : ` WHERE 1=1${tf.sql}`;
    params.push(...tf.params);
    sql += ` ORDER BY t.start_date DESC, t.id DESC`;

    const [rows] = await db.execute(sql, params);
    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map(mapTaskRow),
    });
  } catch (error) {
    console.error('Error getting tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting tasks',
      error: error.message,
    });
  }
};


const getTaskById = async (req, res) => {
  try {
    const { id } = req.params;
    const { select, join } = await buildTaskQueryFragments();
    const tf = tenantTaskFilter(req.user && req.user.tenant, 't');
    const [rows] = await db.execute(
      `SELECT t.*, ${select}
       FROM tasks t
       ${join}
       WHERE t.id = ?${tf.sql}`,
      [id, ...tf.params]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    res.status(200).json({ success: true, data: mapTaskRow(rows[0]) });
  } catch (error) {
    console.error('Error getting task by id:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting task by id',
      error: error.message,
    });
  }
};

// PUT /api/tasks/:id
const updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      taskType,
      contractId,
      replacementDeviceId,
      siteId,
      siteName,
      vendorName,
      vendorTel,
      reporterName,
      reporterTel,
      reporterPosition,
      reporterEmail,
      ticket,
      rootCause,
      resolution,
      duration,
      coverageScope,
      startDate,
      endDate,
      engineers,
      assets,
      assetBinding,
      status,
      actuallyWent,
      notes,
      rescheduleNote,
      photos,
      assignedService,
      assigned_service,
    } = req.body;

    const dtPatch = parseDowntimePatch(req.body);

    const [existing] = await db.execute('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing[0]) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!(await isTaskVisibleToTenant(id, req.user && req.user.tenant))) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    /** Done + มี report แล้ว — ห้ามเปลี่ยน status (รองรับ UI ล็อก + กันยิง API) */
    if (status !== undefined) {
      try {
        const [repRows] = await db.execute('SELECT 1 FROM report WHERE id = ? LIMIT 1', [id]);
        const hasReport = Array.isArray(repRows) && repRows.length > 0;
        const wasDone = String(existing[0].status || '').toLowerCase() === 'done';
        const nextSt = String(status || 'not-started').toLowerCase();
        if (hasReport && wasDone && nextSt !== 'done') {
          return res.status(403).json({
            success: false,
            message: 'Cannot change status: task is Done and a checklist report already exists.',
          });
        }
      } catch (e) {
        console.warn('[updateTask] report check:', e.message);
      }
    }

    // Helper function to safely parse integer
    const safeParseInt = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
      return isNaN(parsed) ? null : parsed;
    };

    const oldReplacementDeviceId = existing[0].replacement_device_id;
    const oldAssets = existing[0].assets
      ? (typeof existing[0].assets === 'string' ? JSON.parse(existing[0].assets) : existing[0].assets)
      : [];

    const updates = [];
    const values = [];

    const addUpdate = (field, value) => {
      updates.push(`${field} = ?`);
      values.push(value);
    };

    if (taskType !== undefined) addUpdate('task_type', taskType);
    if (contractId !== undefined) addUpdate('contract_id', contractId || null);
    if (replacementDeviceId !== undefined) addUpdate('replacement_device_id', replacementDeviceId || null);
    if (siteId !== undefined) addUpdate('site_id', siteId || null);
    if (siteName !== undefined) addUpdate('site_name', siteName || null);
    if (vendorName !== undefined) addUpdate('vendor_name', vendorName || null);
    if (vendorTel !== undefined) addUpdate('vendor_tel', vendorTel || null);
    if (reporterName !== undefined) addUpdate('reporter_name', reporterName || null);
    if (reporterTel !== undefined) addUpdate('reporter_tel', reporterTel || null);
    if (reporterPosition !== undefined && (await taskColumnExists('reporter_position'))) {
      addUpdate('reporter_position', reporterPosition || null);
    }
    if (reporterEmail !== undefined && (await taskColumnExists('reporter_email'))) {
      addUpdate('reporter_email', reporterEmail || null);
    }
    if (ticket !== undefined) addUpdate('ticket', ticket || null);
    if (rootCause !== undefined) addUpdate('root_cause', rootCause || null);
    if (resolution !== undefined) addUpdate('resolution', resolution || null);
    if (coverageScope !== undefined) addUpdate('coverage_scope', coverageScope || null);
    if (await taskColumnExists('duration')) {
      const effTaskType = String(
        taskType !== undefined ? taskType : existing[0].task_type || ''
      ).toUpperCase();
      if (effTaskType === 'MA') {
        addUpdate('duration', 0);
      } else if (duration !== undefined) {
        addUpdate('duration', duration || null);
      }
    }
    const ddColU = await resolveDowntimeDateCol();
    if (dtPatch.downtimeDate !== undefined && ddColU) {
      addUpdate(ddColU, dtPatch.downtimeDate || null);
    }
    const dtColU = await resolveDowntimeTimeCol();
    if (dtPatch.downtimeTime !== undefined && dtColU) {
      addUpdate(dtColU, normalizeMysqlTime(dtPatch.downtimeTime));
    }
    const effTaskTypeEarly = taskType !== undefined ? taskType : existing[0].task_type;
    if (String(effTaskTypeEarly || '').toUpperCase() === 'MA') {
      if (dtPatch.downtimeDate !== undefined && !ddColU) {
        console.warn(
          '[updateTask] downtimeDate ไม่ถูกบันทึก (ไม่พบคอลัมน์ใน tasks) — รัน migrations/add_tasks_ma_downtime.sql',
          { id }
        );
      }
      if (dtPatch.downtimeTime !== undefined && !dtColU) {
        console.warn(
          '[updateTask] downtimeTime ไม่ถูกบันทึก (ไม่พบคอลัมน์ใน tasks) — รัน migrations/add_tasks_ma_downtime.sql',
          { id }
        );
      }
    }
    const udColU = await resolveUptimeDateCol();
    if (dtPatch.uptimeDate !== undefined && udColU) {
      addUpdate(udColU, dtPatch.uptimeDate || null);
    }
    const utColU = await resolveUptimeTimeCol();
    if (dtPatch.uptimeTime !== undefined && utColU) {
      addUpdate(utColU, normalizeMysqlTime(dtPatch.uptimeTime));
    }
    // Task that is done cannot be changed
    if (existing[0].status !== 'done') {
      if (startDate !== undefined) addUpdate('start_date', startDate);
      if (endDate !== undefined) addUpdate('end_date', endDate);
    }
    if (engineers !== undefined) addUpdate('engineers', engineers && engineers.length > 0 ? JSON.stringify(engineers) : null);
    let assetsForUpdate = undefined;
    if (assets !== undefined) {
      assetsForUpdate = assets;
      const effTaskTypeForAssets = String(
        taskType !== undefined ? taskType : existing[0].task_type || ''
      ).toUpperCase();
      if (effTaskTypeForAssets === 'MA' && Array.isArray(assets) && assets.length > 0) {
        try {
          assetsForUpdate = await persistManualMaAssets(assets, {
            tenant: req.user && req.user.tenant,
            siteId:
              siteId !== undefined
                ? safeParseInt(siteId)
                : safeParseInt(existing[0].site_id),
            contractId:
              contractId !== undefined
                ? safeParseInt(contractId)
                : safeParseInt(existing[0].contract_id),
            siteName:
              siteName !== undefined
                ? siteName || null
                : existing[0].site_name || null,
          });
        } catch (persistErr) {
          console.error('[updateTask] persistManualMaAssets:', persistErr);
          return res.status(400).json({
            success: false,
            message: persistErr.message || 'Failed to save manual device to database',
          });
        }
      }
      addUpdate(
        'assets',
        assetsForUpdate && assetsForUpdate.length > 0 ? JSON.stringify(assetsForUpdate) : null
      );
      // ถ้า replacement กรอกเอง — ใช้ Did ที่เพิ่ง INSERT เป็น replacement_device_id
      const persistedRepId = safeParseInt(assetsForUpdate?.[0]?.replacementDeviceId);
      if (persistedRepId != null && safeParseInt(replacementDeviceId) == null) {
        addUpdate('replacement_device_id', persistedRepId);
      }
    }
    if (assetBinding !== undefined) addUpdate('asset_binding', assetBinding || null);
    if (status !== undefined) addUpdate('status', status || 'not-started');
    if (actuallyWent !== undefined) addUpdate('actually_went', actuallyWent ? 1 : 0);
    if (notes !== undefined) {
      const nextStatus = status !== undefined ? status : existing[0].status;
      addUpdate('notes', clampNotesForWorkingStatus(notes, nextStatus));
    }
    if (rescheduleNote !== undefined) addUpdate('reschedule_note', rescheduleNote || null);
    if (photos !== undefined) addUpdate('photos', photos && photos.length > 0 ? JSON.stringify(photos) : null);

    if (await taskColumnExists('assigned_service')) {
      const nextTT = String(
        taskType !== undefined ? taskType : existing[0].task_type || ''
      ).toUpperCase();
      const asInBody = assignedService !== undefined || assigned_service !== undefined;
      if (asInBody) {
        addUpdate(
          'assigned_service',
          nextTT === 'MA' ? normalizeAssignedServiceFromBody(req.body) : null
        );
      } else if (taskType !== undefined && nextTT === 'PM') {
        addUpdate('assigned_service', null);
      }
    }

    const taskChanges = collectTaskChanges(existing[0], req.body);

    if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No data to update' });
    }

    values.push(id);
    const updateSql = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`;
    await db.execute(updateSql, values);

    const effTypeAfterUpdate = taskType !== undefined ? taskType : existing[0].task_type;
    if (String(effTypeAfterUpdate || '').toUpperCase() === 'MA') {
      if (
        dtPatch.uptimeDate !== undefined ||
        dtPatch.uptimeTime !== undefined ||
        dtPatch.downtimeDate !== undefined ||
        dtPatch.downtimeTime !== undefined
      ) {
        await persistMaDowntimeTotalHoursForTask(id);
      }
    }

    // Handle replacement device asset state changes and SLid assignment
    // MA: อัปเดต Asset_State และ SLid เฉพาะเมื่อ status = 'done' (กด Done ใน detail)
    const newStatus = status !== undefined ? (status || 'not-started') : existing[0].status;
    const newAssets = assets !== undefined ? assetsForUpdate : oldAssets;
    const newReplacementDeviceId = (() => {
      const fromCol =
        replacementDeviceId !== undefined
          ? safeParseInt(replacementDeviceId)
          : safeParseInt(oldReplacementDeviceId);
      if (fromCol != null) return fromCol;
      return safeParseInt(newAssets?.[0]?.replacementDeviceId);
    })();
    const newContractId = contractId !== undefined ? contractId : existing[0].contract_id;
    const currentTaskType = taskType !== undefined ? taskType : existing[0].task_type;
    const mergedTicket = ticket !== undefined ? (ticket || null) : existing[0].ticket;
    const mergedAssignedService = (() => {
      const asInBody = assignedService !== undefined || assigned_service !== undefined;
      if (asInBody) {
        return String(currentTaskType || '').toUpperCase() === 'MA'
          ? normalizeAssignedServiceFromBody(req.body)
          : null;
      }
      return existing[0].assigned_service ?? null;
    })();
    if (currentTaskType === 'MA') {
      await syncMaReferTicketOnDevices(newAssets, mergedTicket, newReplacementDeviceId);
      await syncMaAssignedServiceOnDevices(
        newAssets,
        mergedAssignedService,
        newReplacementDeviceId
      );
    }

    if (
      newStatus === 'done' &&
      newAssets &&
      newAssets.length > 0 &&
      currentTaskType === 'MA'
    ) {
      try {
        const isBecomingDone = existing[0].status !== 'done' && newStatus === 'done';
        const taskSiteId = siteId !== undefined ? safeParseInt(siteId) : existing[0].site_id;

        // อุปกรณ์ที่เสีย — เปลี่ยน status + ย้าย site (In Store → คลัง) แม้ไม่มี replacement
        if (isBecomingDone || JSON.stringify(oldAssets) !== JSON.stringify(newAssets)) {
          await applyMaBrokenAssetStatesOnDone(newAssets);
        }

        if (newReplacementDeviceId) {
          if (oldReplacementDeviceId && oldReplacementDeviceId !== newReplacementDeviceId) {
            await updateDeviceAssetState(oldReplacementDeviceId, 'In Store');
            await db.execute('UPDATE devices SET SLid = NULL WHERE Did = ?', [oldReplacementDeviceId]);
          }

          if (isBecomingDone || newReplacementDeviceId !== oldReplacementDeviceId) {
            await updateDeviceAssetState(newReplacementDeviceId, 'In Use');
          }
          if (taskSiteId && newReplacementDeviceId) {
            await db.execute('UPDATE devices SET SLid = ? WHERE Did = ?', [taskSiteId, newReplacementDeviceId]);
          }

          const newFirstAsset = newAssets[0];
          const newOriginalDeviceId = typeof newFirstAsset === 'object' ? (newFirstAsset.id || newFirstAsset.Did || newFirstAsset) : newFirstAsset;

          if (JSON.stringify(oldAssets) !== JSON.stringify(newAssets) && oldAssets.length > 0) {
            const oldFirstAsset = oldAssets[0];
            const oldOriginalDeviceId = typeof oldFirstAsset === 'object' ? (oldFirstAsset.id || oldFirstAsset.Did || oldFirstAsset) : oldFirstAsset;
            if (oldOriginalDeviceId && oldOriginalDeviceId !== newOriginalDeviceId) {
              await updateDeviceAssetState(oldOriginalDeviceId, 'In Store');
              await assignDeviceToInStoreWarehouse(db, oldOriginalDeviceId);
            }
          }

          const contractSlid = safeParseInt(newContractId);
          const replacementIdNum = typeof newReplacementDeviceId === 'number' ? newReplacementDeviceId : parseInt(String(newReplacementDeviceId), 10);
          const originalIdNum = typeof newOriginalDeviceId === 'number' ? newOriginalDeviceId : parseInt(String(newOriginalDeviceId), 10);

          if (contractSlid && !isNaN(replacementIdNum)) {
            try {
              const slidToUse = taskSiteId != null ? taskSiteId : contractSlid;
              await db.execute('UPDATE devices SET SLid = ? WHERE Did = ?', [slidToUse, replacementIdNum]);
              console.log(
                `Assigned replacement device ${replacementIdNum} to SLid ${slidToUse} (was broken device ${originalIdNum})`
              );
            } catch (error) {
              console.error('Error assigning replacement device to SLid:', error);
            }
          }
        }
      } catch (error) {
        console.error('Error updating device asset states:', error);
      }
    } else if (existing[0].status === 'done' && oldReplacementDeviceId && (!newReplacementDeviceId || !newAssets || newAssets.length === 0)) {
      try {
        await updateDeviceAssetState(oldReplacementDeviceId, 'In Store');
        await db.execute('UPDATE devices SET SLid = NULL WHERE Did = ?', [oldReplacementDeviceId]);
      } catch (error) {
        console.error('Error reverting replacement device:', error);
      }
    }

    const { select, join } = await buildTaskQueryFragments();
    const [rows] = await db.execute(
      `SELECT t.*, ${select}
       FROM tasks t
       ${join}
       WHERE t.id = ?`,
      [id]
    );
    const updatedTask = mapTaskRow(rows[0]);

    if (taskChanges.length > 0) {
      notifyTeamsPlanUpdated(updatedTask, {
        actor: getTeamsActor(req.user),
        changes: taskChanges,
      }).catch((err) => {
        console.error('[updateTask] Teams notification failed:', err?.message || err);
      });
    }

    res.status(200).json({
      success: true,
      message: 'Task updated successfully',
      data: updatedTask,
    });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating task',
      error: error.message,
    });
  }
};

// DELETE /api/tasks/:id
const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if task exists
    const [existing] = await db.execute('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing[0]) {
      return res.status(404).json({ success: false, message: ' Task not found' });
    }
    if (!(await isTaskVisibleToTenant(id, req.user && req.user.tenant))) {
      return res.status(404).json({ success: false, message: ' Task not found' });
    }

    // ลบ report ที่ผูกกับ task นี้ก่อน (FK report.id -> tasks.id) เพื่อไม่ให้ constraint กันการลบ
    await db.execute('DELETE FROM report WHERE id = ?', [id]);

    // Delete the task
    await db.execute('DELETE FROM tasks WHERE id = ?', [id]);

    res.status(200).json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting task',
      error: error.message,
    });
  }
};

// GET /api/tasks/check-conflict - เช็คว่า engineer มีงานซ้อนทับหรือไม่
const checkEngineerConflict = async (req, res) => {
  try {
    const { engineerId, startDate, endDate, excludeTaskId } = req.query;

    if (!engineerId || !startDate) {
      return res.status(400).json({
        success: false,
        message: 'Please specify engineerId and startDate',
      });
    }

    // Parse dates
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date(startDate);
    
    // Format dates as YYYY-MM-DD for SQL comparison
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    const startDateStr = formatDate(start);
    const endDateStr = formatDate(end);

    // Query tasks ที่ engineer คนนี้มีงานและ overlap กับวันที่ที่ระบุ
    // engineers เก็บเป็น JSON array เช่น [{"id":"9","name":"Chainarin","lastName":"Phosai"}]
    // ใช้ JSON_SEARCH เพื่อหา engineer ID ใน array โดยเช็คทั้ง id property และ value โดยตรง
    // Overlap condition: (newStart <= existingEnd AND newEnd >= existingStart)
    let sql = `
      SELECT t.id, t.site_name, t.start_date, t.end_date, t.engineers
      FROM tasks t
      WHERE t.start_date IS NOT NULL
        AND t.engineers IS NOT NULL
        AND (
          JSON_SEARCH(t.engineers, 'one', ?, NULL, '$[*].id') IS NOT NULL
          OR JSON_CONTAINS(t.engineers, JSON_QUOTE(?))
        )
        AND (
          (t.start_date <= ? AND COALESCE(t.end_date, t.start_date) >= ?)
        )
    `;
    
    const tf = tenantTaskFilter(req.user && req.user.tenant, 't');
    sql += tf.sql;
    const params = [String(engineerId), String(engineerId), endDateStr, startDateStr, ...tf.params];

    // ถ้ามี excludeTaskId (เช่น ตอน edit) ให้ข้าม task นั้น
    if (excludeTaskId) {
      sql += ` AND t.id != ?`;
      params.push(excludeTaskId);
    }

    sql += ` ORDER BY t.start_date ASC LIMIT 1`;

    const [rows] = await db.execute(sql, params);

    if (rows.length > 0) {
      const conflictingTask = mapTaskRow(rows[0]);
      return res.status(200).json({
        success: true,
        hasConflict: true,
        conflictingTask: {
          id: conflictingTask.id,
          siteName: conflictingTask.siteName,
          startDate: conflictingTask.startDate,
          endDate: conflictingTask.endDate,
        },
      });
    }

    return res.status(200).json({
      success: true,
      hasConflict: false,
      conflictingTask: null,
    });
  } catch (error) {
    console.error('Error checking engineer conflict:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking engineer conflict',
      error: error.message,
    });
  }
};

// GET /api/tasks/overdue?task_type=MA | PM — ดึงงานเกินกำหนด: status='not-started', end_date < CURRENT_DATE, แยกตาม task_type
const getOverdueTasks = async (req, res) => {
  try {
    const taskType = (req.query.task_type || '').toUpperCase();
    const sid = req.query.sid != null && req.query.sid !== '' ? Number(req.query.sid) : null;
    const lid = req.query.lid != null && req.query.lid !== '' ? Number(req.query.lid) : null;
    if (taskType !== 'MA' && taskType !== 'PM') {
      return res.status(400).json({
        success: false,
        message: 'Please specify task_type as MA or PM',
      });
    }
    if ((sid != null && Number.isNaN(sid)) || (lid != null && Number.isNaN(lid))) {
      return res.status(400).json({
        success: false,
        message: 'Please specify sid/lid as a number',
      });
    }
    const { select, join } = await buildTaskQueryFragmentsWithSlFilter();
    const [rows] = await db.execute(
      `SELECT t.*, ${select}
       FROM tasks t
       ${join}
       WHERE t.status = 'not-started' AND t.end_date < CURRENT_DATE AND t.task_type = ?
         AND (? IS NULL OR sl.Sid = ?)
         AND (? IS NULL OR sl.lid = ?)
         ${tenantTaskFilter(req.user && req.user.tenant, 't').sql}
       ORDER BY t.end_date ASC, t.id ASC`,
      [taskType, sid, sid, lid, lid]
    );
    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map(mapTaskRow),
    });
  } catch (error) {
    console.error('Error getting overdue tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting overdue tasks',
      error: error.message,
    });
  }
};

// GET /api/tasks/completed?task_type=MA | PM — ดึงงานที่เสร็จแล้ว: status='done', แยกตาม task_type
const getCompletedTasks = async (req, res) => {
  try {
    const taskType = (req.query.task_type || '').toUpperCase();
    const sid = req.query.sid != null && req.query.sid !== '' ? Number(req.query.sid) : null;
    const lid = req.query.lid != null && req.query.lid !== '' ? Number(req.query.lid) : null;
    if (taskType !== 'MA' && taskType !== 'PM') {
      return res.status(400).json({
        success: false,
        message: 'Please specify task_type as MA or PM',
      });
    }
    if ((sid != null && Number.isNaN(sid)) || (lid != null && Number.isNaN(lid))) {
      return res.status(400).json({
        success: false,
        message: 'Please specify sid/lid as a number',
      });
    }
    const { select, join } = await buildTaskQueryFragmentsWithSlFilter();
    const [rows] = await db.execute(
      `SELECT t.*, ${select}
       FROM tasks t
       ${join}
       WHERE t.status = 'done' AND t.task_type = ?
         AND (? IS NULL OR sl.Sid = ?)
         AND (? IS NULL OR sl.lid = ?)
         ${tenantTaskFilter(req.user && req.user.tenant, 't').sql}
       ORDER BY t.end_date DESC, t.id DESC`,
      [taskType, sid, sid, lid, lid]
    );
    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map(mapTaskRow),
    });
  } catch (error) {
    console.error('Error getting completed tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting completed tasks',
      error: error.message,
    });
  }
};

// GET /api/tasks/inprocess?task_type=MA | PM — นิยามตาม analytics:
// - inprocess = status='working' OR (status='done' AND ไม่มี report)
const getInprocessTasks = async (req, res) => {
  try {
    const taskType = (req.query.task_type || '').toUpperCase();
    const sid = req.query.sid != null && req.query.sid !== '' ? Number(req.query.sid) : null;
    const lid = req.query.lid != null && req.query.lid !== '' ? Number(req.query.lid) : null;
    if (taskType !== 'MA' && taskType !== 'PM') {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุ task_type เป็น MA หรือ PM',
      });
    }
    if ((sid != null && Number.isNaN(sid)) || (lid != null && Number.isNaN(lid))) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุ sid/lid เป็นตัวเลข',
      });
    }
    const { select, join } = await buildTaskQueryFragmentsWithSlFilter();
    const [rows] = await db.execute(
      `SELECT t.*, ${select}
       FROM tasks t
       ${join}
       LEFT JOIN report r ON r.id = t.id
       WHERE t.task_type = ?
         AND (LOWER(t.status) = 'working' OR (LOWER(t.status) = 'done' AND r.id IS NULL))
         AND (? IS NULL OR sl.Sid = ?)
         AND (? IS NULL OR sl.lid = ?)
         ${tenantTaskFilter(req.user && req.user.tenant, 't').sql}
       ORDER BY t.end_date ASC, t.id ASC`,
      [taskType, sid, sid, lid, lid]
    );
    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map(mapTaskRow),
    });
  } catch (error) {
    console.error('Error getting inprocess tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting inprocess tasks',
      error: error.message,
    });
  }
};

// GET /api/tasks/pending?task_type=MA | PM — นิยามตาม analytics:
// - pending = status NOT IN ('done','working') AND (end_date IS NULL OR end_date >= CURRENT_DATE)
const getPendingTasks = async (req, res) => {
  try {
    const taskType = (req.query.task_type || '').toUpperCase();
    const sid = req.query.sid != null && req.query.sid !== '' ? Number(req.query.sid) : null;
    const lid = req.query.lid != null && req.query.lid !== '' ? Number(req.query.lid) : null;
    if (taskType !== 'MA' && taskType !== 'PM') {
      return res.status(400).json({
        success: false,
        message: 'Please specify task_type as MA or PM',
      });
    }
    if ((sid != null && Number.isNaN(sid)) || (lid != null && Number.isNaN(lid))) {
      return res.status(400).json({
        success: false,
        message: 'Please specify sid/lid as a number',
      });
    }
    const { select, join } = await buildTaskQueryFragmentsWithSlFilter();
    const [rows] = await db.execute(
      `SELECT t.*, ${select}
       FROM tasks t
       ${join}
       WHERE t.task_type = ?
         AND LOWER(t.status) NOT IN ('done', 'working')
         AND (t.end_date IS NULL OR t.end_date >= CURRENT_DATE)
         AND (? IS NULL OR sl.Sid = ?)
         AND (? IS NULL OR sl.lid = ?)
         ${tenantTaskFilter(req.user && req.user.tenant, 't').sql}
       ORDER BY (t.end_date IS NULL) ASC, t.end_date ASC, t.id ASC`,
      [taskType, sid, sid, lid, lid]
    );
    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows.map(mapTaskRow),
    });
  } catch (error) {
    console.error('Error getting pending tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting pending tasks',
      error: error.message,
    });
  }
};

module.exports = {
  createTask,
  getTasks,
  getTaskById,
  getMaNoticeFile,
  updateTask,
  deleteTask,
  checkEngineerConflict,
  getOverdueTasks,
  getCompletedTasks,
  getInprocessTasks,
  getPendingTasks,
};
