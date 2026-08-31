const db = require('../config/database');
const { DEFAULT_IN_STORE_SITE_NAME, resolveAllInStoreSlids } = require('../config/inStoreSite');
const {
  normalizeReferSofKey,
  deviceSofSelect,
  sofMatchWhere,
  noSofWhere,
  REFER_SOF_DROPDOWN_SQL,
  applyReferSofToSiteLocation,
} = require('../config/deviceSof');
const { tenantDeviceFilter, ownerForCreate } = require('../utils/tenantScope');

function tenantClause(req, alias = 'devices') {
  return tenantDeviceFilter(req.user && req.user.tenant, alias);
}

//
// devices_history is populated by DB triggers (trg_devices_insert, trg_devices_update)
// ไม่ต้อง insert จาก application
// POST - สร้าง Device ใหม่ (รองรับทั้ง 1 device และหลาย devices)
// ถ้ามี Asset_Number และมีอยู่ใน database แล้ว จะ update แทน insert
const createDevice = async (req, res) => {
  try {
    // ตรวจสอบว่าเป็น array หรือ object เดียว
    const isArray = Array.isArray(req.body);
    const devices = isArray ? req.body : [req.body];

    // ตรวจสอบว่ามีข้อมูลหรือไม่
    if (devices.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide device data'
      });
    }

    // ตรวจสอบข้อมูลที่จำเป็น (Dtypeid เป็น required)
    for (let i = 0; i < devices.length; i++) {
      if (!devices[i].Dtypeid) {
        return res.status(400).json({
          success: false,
          message: `Please provide Dtypeid (required) - Device ${i + 1}`
        });
      }
    }

    // ดึง Asset_Numbers ทั้งหมดที่ต้องการตรวจสอบ (batch query - เพิ่มความเร็วมาก)
    const assetNumbers = devices
      .filter(d => d.Asset_Number)
      .map(d => d.Asset_Number);

    let existingAssetsMap = new Map();
    if (assetNumbers.length > 0) {
      const placeholders = assetNumbers.map(() => '?').join(',');
      const checkSql = `SELECT Did, Asset_Number FROM devices WHERE Asset_Number IN (${placeholders})`;
      const [existing] = await db.execute(checkSql, assetNumbers);

      // สร้าง map สำหรับค้นหาเร็ว
      existing.forEach(row => {
        existingAssetsMap.set(row.Asset_Number, row.Did);
      });
    }

    // แยก devices ออกเป็น 2 กลุ่ม
    const devicesToInsert = [];
    const devicesToUpdate = [];

    devices.forEach((device, index) => {
      if (device.Asset_Number && existingAssetsMap.has(device.Asset_Number)) {
        devicesToUpdate.push({
          ...device,
          _index: index,
          _id: existingAssetsMap.get(device.Asset_Number)
        });
      } else {
        devicesToInsert.push({
          ...device,
          _index: index
        });
      }
    });

    const insertedDevices = [];
    const updatedDevices = [];
    const errors = [];

    // INSERT devices ใหม่
    if (devicesToInsert.length > 0) {
      // INSERT devices ทีละตัว 
      for (const device of devicesToInsert) {
        try {
          const [result] = await db.execute(
            `INSERT INTO devices (
              Asset_State, serial, CI_Name, Asset_Number, PR_No, Vendor,
              Project_purchase, SLid, PO_No, Loan_Start, Request_Date,
              Refer_Ticket, Assigned_Service, Reason, Dtypeid, DeRoleid,
              Project_code_purchase, Waranty_start, Waranty_end, Received_date, Asset_Type, Owner,
              Project_Owen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              device.Asset_State || null,
              device.serial || null,
              device.CI_Name || null,
              device.Asset_Number || null,
              device.PR_No || null,
              device.Vendor || null,
              device.Project_purchase || null,
              device.SLid || null,
              device.PO_No || null,
              device.Loan_Start || null,
              device.Request_Date || null,
              device.Refer_Ticket || null,
              device.Assigned_Service || null,
              device.Reason || null,
              device.Dtypeid,
              device.DeRoleid || null,
              device.Project_code_purchase || null,
              device.Waranty_start || null,
              device.Waranty_end || null,
              device.Received_date || null,
              device.Asset_Type || null,
              ownerForCreate(
                req.user && req.user.tenant,
                device.Owner ?? device.Project_Owen
              ),
              device.Project_Owen || null,
            ]
          );

          const deviceId = result.insertId;
          if (device.Refer_SOF !== undefined && device.SLid != null) {
            await applyReferSofToSiteLocation(db, device.SLid, device.Refer_SOF);
          }

          insertedDevices.push({
            id: result.insertId,
            action: 'inserted',
            _index: device._index,
            Asset_State: device.Asset_State,
            serial: device.serial,
            CI_Name: device.CI_Name,
            Asset_Number: device.Asset_Number,
            PR_No: device.PR_No,
            Vendor: device.Vendor,
            SLid: device.SLid,
            PO_No: device.PO_No,
            Loan_Start: device.Loan_Start,
            Request_Date: device.Request_Date,
            Refer_SOF: device.Refer_SOF,
            Refer_Ticket: device.Refer_Ticket,
            Assigned_Service: device.Assigned_Service,
            Reason: device.Reason,
            Dtypeid: device.Dtypeid,
            DeRoleid: device.DeRoleid
          });
        } catch (error) {
          errors.push({
            index: device._index + 1,
            error: error.message,
            device: device
          });
        }
      }
    }

    // UPDATE devices ที่มีอยู่แล้ว
    for (const device of devicesToUpdate) {
      try {
        // ดึงข้อมูลเดิมก่อน update เพื่อตรวจสอบการเปลี่ยนแปลง Asset_State
        const [oldDeviceData] = await db.execute(
          'SELECT Asset_State FROM devices WHERE Did = ?',
          [device._id]
        );
        const oldAssetState = oldDeviceData[0]?.Asset_State || null;

        const updates = [];
        const values = [];
        const changedFields = {};

        if (device.Asset_State !== undefined) {
          updates.push('Asset_State = ?');
          values.push(device.Asset_State);
          changedFields.Asset_State = device.Asset_State;
        }
        if (device.serial !== undefined) {
          updates.push('serial = ?');
          values.push(device.serial);
          changedFields.serial = device.serial;
        }
        if (device.CI_Name !== undefined) {
          updates.push('CI_Name = ?');
          values.push(device.CI_Name);
          changedFields.CI_Name = device.CI_Name;
        }
        if (device.PR_No !== undefined) {
          updates.push('PR_No = ?');
          values.push(device.PR_No);
          changedFields.PR_No = device.PR_No;
        }
        if (device.Vendor !== undefined) {
          updates.push('Vendor = ?');
          values.push(device.Vendor);
          changedFields.Vendor = device.Vendor;
        }
        if (device.SLid !== undefined) {
          updates.push('SLid = ?');
          values.push(device.SLid);
          changedFields.SLid = device.SLid;
        }
        if (device.Project_purchase !== undefined) {
          updates.push('Project_purchase = ?');
          values.push(device.Project_purchase);
          changedFields.Project_purchase = device.Project_purchase;
        }
        if (device.PO_No !== undefined) {
          updates.push('PO_No = ?');
          values.push(device.PO_No);
          changedFields.PO_No = device.PO_No;
        }
        if (device.Loan_Start !== undefined) {
          updates.push('Loan_Start = ?');
          values.push(device.Loan_Start);
          changedFields.Loan_Start = device.Loan_Start;
        }
        if (device.Request_Date !== undefined) {
          updates.push('Request_Date = ?');
          values.push(device.Request_Date);
          changedFields.Request_Date = device.Request_Date;
        }
        const pendingReferSof =
          device.Refer_SOF !== undefined ? device.Refer_SOF : undefined;
        if (pendingReferSof !== undefined) {
          changedFields.Refer_SOF = pendingReferSof;
        }
        if (device.Refer_Ticket !== undefined) {
          updates.push('Refer_Ticket = ?');
          values.push(device.Refer_Ticket);
          changedFields.Refer_Ticket = device.Refer_Ticket;
        }
        if (device.Assigned_Service !== undefined) {
          updates.push('Assigned_Service = ?');
          values.push(device.Assigned_Service);
          changedFields.Assigned_Service = device.Assigned_Service;
        }
        if (device.Reason !== undefined) {
          updates.push('Reason = ?');
          values.push(device.Reason);
          changedFields.Reason = device.Reason;
        }
        if (device.warranty !== undefined) {
          updates.push('warranty = ?');
          values.push(device.warranty);
          changedFields.warranty = device.warranty;
        }
        if (device.Dtypeid !== undefined) {
          updates.push('Dtypeid = ?');
          values.push(device.Dtypeid);
          changedFields.Dtypeid = device.Dtypeid;
        }
        if (device.DeRoleid !== undefined) {
          updates.push('DeRoleid = ?');
          values.push(device.DeRoleid);
          changedFields.DeRoleid = device.DeRoleid;
        }

        if (updates.length > 0) {
          values.push(device._id);
          const updateSql = `UPDATE devices SET ${updates.join(', ')} WHERE Did = ?`;
          await db.execute(updateSql, values);

          const newAssetState = device.Asset_State !== undefined ? device.Asset_State : oldAssetState;

          updatedDevices.push({
            id: device._id,
            action: 'updated',
            _index: device._index
          });
        } else if (pendingReferSof !== undefined) {
          updatedDevices.push({
            id: device._id,
            action: 'updated',
            _index: device._index
          });
        } else {
          updatedDevices.push({
            id: device._id,
            action: 'no_changes',
            _index: device._index
          });
        }

        if (pendingReferSof !== undefined) {
          let slidForSof = device.SLid;
          if (slidForSof == null) {
            const [slRows] = await db.execute('SELECT SLid FROM devices WHERE Did = ?', [device._id]);
            slidForSof = slRows[0]?.SLid;
          }
          if (slidForSof != null) {
            await applyReferSofToSiteLocation(db, slidForSof, pendingReferSof);
          }
        }
      } catch (error) {
        errors.push({
          index: device._index + 1,
          error: error.message,
          device: device
        });
      }
    }


    // ถ้ามี error บางตัว
    if (errors.length > 0 && insertedDevices.length === 0 && updatedDevices.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Error creating/updating devices',
        errors: errors
      });
    }

    // เรียงผลลัพธ์ตาม index เดิม
    const allResults = [...insertedDevices, ...updatedDevices].sort((a, b) => a._index - b._index);

    // ลบ _index ออกก่อนส่ง response
    allResults.forEach(result => delete result._index);

    // Response
    if (isArray) {
      // ส่งหลาย devices
      res.status(201).json({
        success: true,
        message: `Processed devices successfully ${allResults.length} records (created ${insertedDevices.length} records, updated ${updatedDevices.length} records)${errors.length > 0 ? ` (errors ${errors.length} records)` : ''}`,
        count: allResults.length,
        inserted: insertedDevices.length,
        updated: updatedDevices.length,
        data: allResults,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      // ส่ง device เดียว
      res.status(201).json({
        success: true,
        message: allResults[0].action === 'updated' ? 'Device updated successfully' : 'Device created successfully',
        data: allResults[0]
      });
    }
  } catch (error) {
    console.error('Error creating device:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating device',
      error: error.message
    });
  }
};

// GET - ดึงข้อมูล Devices (พร้อม Pagination และ Search)
const getDevices = async (req, res) => {
  try {
    const tf = tenantClause(req, 'devices');
    // ดึง query parameters
    const page = parseInt(req.query.page) || 1; // หน้าปัจจุบัน (default: 1)
    const limit = parseInt(req.query.limit) || 50; // จำนวน records ต่อหน้า (default: 50)
    const search = req.query.search || ''; // คำค้นหา (optional)
    const offset = (page - 1) * limit; // คำนวณ offset

    // สร้าง WHERE condition สำหรับ search
    let searchCondition = '';
    let searchParams = [];

    if (search) {
      const searchPattern = `%${search}%`;
      searchCondition = `AND (
        devices.Asset_State LIKE ? OR 
        devices.serial LIKE ? OR 
        devices.CI_Name LIKE ? OR 
        devices.Asset_Number LIKE ? OR 
        devices.PR_No LIKE ? OR 
        devices.Vendor LIKE ?
      )`;
      searchParams = [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern];
    }

    // app_db: devices.SLid = sites_location.SLid, sites_location.Sid = sites.Sid
    const countSql = `SELECT COUNT(*) as total 
                      FROM devices
                      JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                      JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                      LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                      LEFT JOIN sites ON sites_location.Sid = sites.Sid
                      WHERE 1=1 ${tf.sql} ${searchCondition}`;
    const [countResult] = await db.execute(countSql, [...tf.params, ...searchParams]);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    const sql = `SELECT Did, Asset_State, serial, CI_Name, Asset_Number, PR_No, Vendor, 
                 devices.SLid, L.Location2, PO_No, Loan_Start, Request_Date, sl.SOF AS Refer_SOF, 
                 Refer_Ticket, devices.Assigned_Service, Reason, devices.Dtypeid, 
                 device_type.model, manufacturer.name as manufacturername, sites.Name as Sitename 
                 FROM devices
                 JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                 JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                 LEFT JOIN sites_location sl ON devices.SLid = sl.SLid
                 LEFT JOIN sites ON sl.Sid = sites.Sid
                 LEFT JOIN location L ON sl.lid = L.lid
                 WHERE 1=1 ${tf.sql} ${searchCondition}
                 ORDER BY Did DESC 
                 LIMIT ? OFFSET ?`;

    const [rows] = await db.execute(sql, [...tf.params, ...searchParams, limit, offset]);

    // นับจำนวนแยกตาม Asset_State สำหรับผลลัพธ์ที่ค้นหาได้ (ถ้ามี search)
    let assetStateStats = [];
    if (search) {
      const assetStateSql = `SELECT devices.Asset_State, COUNT(*) AS total
                             FROM devices
                             JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                             JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                             LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                             LEFT JOIN sites ON sites_location.Sid = sites.Sid
                             WHERE 1=1 ${tf.sql} ${searchCondition}
                             GROUP BY devices.Asset_State`;
      const [assetStateResult] = await db.execute(assetStateSql, [...tf.params, ...searchParams]);
      assetStateStats = assetStateResult;
    }

    res.status(200).json({
      success: true,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        recordsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      search: search || null,
      assetStateStats: search ? assetStateStats : null,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Error getting devices:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices',
      error: error.message
    });
  }
};

// GET - ดึงข้อมูล Devices ที่ไม่ใช่ Asset_State = "In Store" (พร้อม Pagination และ Search)
const getDevicesExcludeInStore = async (req, res) => {
  try {
    const tf = tenantClause(req, 'devices');
    // ดึง query parameters
    const page = parseInt(req.query.page) || 1; // หน้าปัจจุบัน (default: 1)
    const limit = parseInt(req.query.limit) || 50; // จำนวน records ต่อหน้า (default: 50)
    const search = req.query.search || ''; // คำค้นหา (optional)
    const offset = (page - 1) * limit; // คำนวณ offset

    // สร้าง WHERE condition สำหรับ search
    let searchCondition = '';
    let searchParams = [];

    if (search) {
      const searchPattern = `%${search}%`;
      searchCondition = `AND (
        devices.Asset_State LIKE ? OR 
        devices.serial LIKE ? OR 
        devices.CI_Name LIKE ? OR 
        devices.Asset_Number LIKE ? OR 
        devices.PR_No LIKE ? OR 
        devices.Vendor LIKE ?
      )`;
      searchParams = [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern];
    }

    const countSql = `SELECT COUNT(*) as total 
                      FROM devices
                      JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                      JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                      LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                      LEFT JOIN sites ON sites_location.Sid = sites.Sid
                      WHERE (devices.Asset_State IS NULL OR devices.Asset_State != 'In Store')
                      ${tf.sql}
                      ${searchCondition}`;
    const [countResult] = await db.execute(countSql, [...tf.params, ...searchParams]);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    const sql = `SELECT Did, Asset_State, serial, CI_Name, Asset_Number, PR_No, Vendor,
                 devices.SLid, PO_No, Loan_Start, Request_Date, sites_location.SOF AS Refer_SOF, 
                 Refer_Ticket, devices.Assigned_Service, Reason, devices.Dtypeid, 
                 device_type.model, manufacturer.name as manufacturername, sites.Name as Sitename 
                 FROM devices
                 JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                 JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                 LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                 LEFT JOIN sites ON sites_location.Sid = sites.Sid
                 WHERE (devices.Asset_State IS NULL OR devices.Asset_State != 'In Store')
                 ${tf.sql}
                 ${searchCondition}
                 ORDER BY Did DESC 
                 LIMIT ? OFFSET ?`;

    const [rows] = await db.execute(sql, [...tf.params, ...searchParams, limit, offset]);

    // นับจำนวนแยกตาม Asset_State สำหรับผลลัพธ์ที่ค้นหาได้ (ถ้ามี search)
    let assetStateStats = [];
    if (search) {
      const assetStateSql = `SELECT devices.Asset_State, COUNT(*) AS total
                             FROM devices
                             JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                             JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                             LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                             LEFT JOIN sites ON sites_location.Sid = sites.Sid
                             WHERE (devices.Asset_State IS NULL OR devices.Asset_State != 'In Store')
                             ${tf.sql}
                             ${searchCondition}
                             GROUP BY devices.Asset_State`;
      const [assetStateResult] = await db.execute(assetStateSql, [...tf.params, ...searchParams]);
      assetStateStats = assetStateResult;
    }

    res.status(200).json({
      success: true,
      excludedAssetState: 'In Store',
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        recordsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      search: search || null,
      assetStateStats: search ? assetStateStats : null,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Error getting devices exclude In Store:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices exclude In Store',
      error: error.message
    });
  }
};

// GET - ดึงข้อมูล Devices ที่ไม่ใช่ Asset_State = "Out Store" (พร้อม Pagination และ Search)
const getDevicesExcludeOutStore = async (req, res) => {
  try {
    const tf = tenantClause(req, 'devices');
    // ดึง query parameters
    const page = parseInt(req.query.page) || 1; // หน้าปัจจุบัน (default: 1)
    const limit = parseInt(req.query.limit) || 50; // จำนวน records ต่อหน้า (default: 50)
    const search = req.query.search || ''; // คำค้นหา (optional)
    const offset = (page - 1) * limit; // คำนวณ offset

    // สร้าง WHERE condition สำหรับ search
    let searchCondition = '';
    let searchParams = [];

    if (search) {
      const searchPattern = `%${search}%`;
      searchCondition = `AND (
        devices.Asset_State LIKE ? OR 
        devices.serial LIKE ? OR 
        devices.CI_Name LIKE ? OR 
        devices.Asset_Number LIKE ? OR 
        devices.PR_No LIKE ? OR 
        devices.Vendor LIKE ?
      )`;
      searchParams = [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern];
    }

    const countSql = `SELECT COUNT(*) as total 
                      FROM devices
                      JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                      JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                      LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                      LEFT JOIN sites ON sites_location.Sid = sites.Sid
                      WHERE (devices.Asset_State IS NULL OR devices.Asset_State != 'Out Store')
                      ${tf.sql}
                      ${searchCondition}`;
    const [countResult] = await db.execute(countSql, [...tf.params, ...searchParams]);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    const sql = `SELECT Did, Asset_State, serial, CI_Name, Asset_Number, PR_No, Vendor, 
                 devices.SLid, PO_No, Loan_Start, Request_Date, sites_location.SOF AS Refer_SOF, 
                 Refer_Ticket, devices.Assigned_Service, Reason, devices.Dtypeid, 
                 device_type.model, manufacturer.name as manufacturername, sites.Name as Sitename 
                 FROM devices
                 JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                 JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                 LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                 LEFT JOIN sites ON sites_location.Sid = sites.Sid
                 WHERE (devices.Asset_State IS NULL OR devices.Asset_State != 'Out Store')
                 ${tf.sql}
                 ${searchCondition}
                 ORDER BY Did DESC 
                 LIMIT ? OFFSET ?`;

    const [rows] = await db.execute(sql, [...tf.params, ...searchParams, limit, offset]);

    // นับจำนวนแยกตาม Asset_State สำหรับผลลัพธ์ที่ค้นหาได้ (ถ้ามี search)
    let assetStateStats = [];
    if (search) {
      const assetStateSql = `SELECT devices.Asset_State, COUNT(*) AS total
                             FROM devices
                             JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
                             JOIN manufacturer ON device_type.Mid = manufacturer.Mid
                             LEFT JOIN sites_location ON devices.SLid = sites_location.SLid
                             LEFT JOIN sites ON sites_location.Sid = sites.Sid
                             WHERE (devices.Asset_State IS NULL OR devices.Asset_State != 'Out Store')
                             ${tf.sql}
                             ${searchCondition}
                             GROUP BY devices.Asset_State`;
      const [assetStateResult] = await db.execute(assetStateSql, [...tf.params, ...searchParams]);
      assetStateStats = assetStateResult;
    }

    res.status(200).json({
      success: true,
      excludedAssetState: 'Out Store',
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        recordsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      search: search || null,
      assetStateStats: search ? assetStateStats : null,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Error getting devices exclude Out Store:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices exclude Out Store',
      error: error.message
    });
  }
};

// GET - ดึงข้อมูล Device ตาม ID
const getDeviceById = async (req, res) => {
  try {
    const { id } = req.params;
    const tf = tenantClause(req, 'devices');

    const sql = `SELECT Did, Asset_State, serial, CI_Name, Asset_Number, PR_No, Vendor,
                 devices.SLid, L.Location2, PO_No, Loan_Start, Request_Date, sl.SOF AS Refer_SOF, 
                 Refer_Ticket, devices.Assigned_Service, Reason, devices.Dtypeid, devices.DeRoleid,
                 device_type.model, manufacturer.name as manufacturername, sites.Name as Sitename,
                 dr.name as roleName
                 FROM devices
                 LEFT JOIN device_type ON devices.Dtypeid = device_type.Dtypeid 
                 LEFT JOIN manufacturer ON device_type.Mid = manufacturer.Mid 
                 LEFT JOIN device_role dr ON devices.DeRoleid = dr.DeRoleid
                 LEFT JOIN sites_location sl ON devices.SLid = sl.SLid
                 LEFT JOIN sites ON sl.Sid = sites.Sid
                 LEFT JOIN location L ON sl.lid = L.lid
                 WHERE devices.Did = ?${tf.sql}`;

    const [rows] = await db.execute(sql, [id, ...tf.params]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    res.status(200).json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    console.error('Error getting device by id:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting device by id',
      error: error.message
    });
  }
};

// PUT - อัพเดท Asset_State (รองรับทั้ง 1 device และหลาย devices)
const updateAssetState = async (req, res) => {
  try {
    // ตรวจสอบว่าเป็น array หรือ object เดียว
    const isArray = Array.isArray(req.body);
    const updates = isArray ? req.body : [req.body];

    // ตรวจสอบว่ามีข้อมูลหรือไม่
    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide device data to update'
      });
    }

    // ตรวจสอบข้อมูลที่จำเป็น
    for (let i = 0; i < updates.length; i++) {
      if (!updates[i].Did) {
        return res.status(400).json({
          success: false,
          message: `Please provide Did (required) - Record ${i + 1}`
        });
      }
      if (updates[i].Asset_State === undefined || updates[i].Asset_State === null) {
        return res.status(400).json({
          success: false,
          message: `Please provide Asset_State (required) - Record ${i + 1}`
        });
      }
    }

    // ดึง Device IDs ทั้งหมดที่ต้องการอัพเดท
    const deviceIds = updates.map(u => u.Did);

    // ดึงข้อมูลเดิมทั้งหมด (batch query)
    const placeholders = deviceIds.map(() => '?').join(',');
    const checkSql = `SELECT Did, Asset_State FROM devices WHERE Did IN (${placeholders})`;
    const [existingDevices] = await db.execute(checkSql, deviceIds);

    // สร้าง map สำหรับค้นหาเร็ว
    const existingMap = new Map();
    existingDevices.forEach(device => {
      existingMap.set(device.Did, device.Asset_State);
    });

    // ตรวจสอบว่า Device ทั้งหมดมีอยู่จริงหรือไม่
    const notFoundIds = deviceIds.filter(id => !existingMap.has(id));
    if (notFoundIds.length > 0) {
      return res.status(404).json({
        success: false,
        message: `Device not found: ${notFoundIds.join(', ')}`
      });
    }

    const updatedDevices = [];
    const errors = [];

    // อัพเดท devices ทีละตัว
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      try {
        const deviceId = update.Did;
        const newAssetState = update.Asset_State;
        const oldAssetState = existingMap.get(deviceId);

        // อัพเดทเฉพาะถ้า Asset_State เปลี่ยน
        if (oldAssetState !== newAssetState) {
          const updateSql = 'UPDATE devices SET Asset_State = ? WHERE Did = ?';
          await db.execute(updateSql, [newAssetState, deviceId]);

          // บันทึกประวัติ ASSET_STATE_CHANGE
          await logDeviceHistory(
            deviceId,
            'ASSET_STATE_CHANGE',
            oldAssetState,
            newAssetState,
            null,
            req.user?.username || req.user?.id || null
          );

          updatedDevices.push({
            Did: deviceId,
            oldAssetState: oldAssetState,
            newAssetState: newAssetState,
            action: 'updated'
          });
        } else {
          // ถ้า Asset_State ไม่เปลี่ยน
          updatedDevices.push({
            Did: deviceId,
            oldAssetState: oldAssetState,
            newAssetState: newAssetState,
            action: 'no_changes'
          });
        }
      } catch (error) {
        errors.push({
          index: i + 1,
          Did: update.Did,
          error: error.message
        });
      }
    }

    // ถ้ามี error บางตัว
    if (errors.length > 0 && updatedDevices.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Error updating asset state',
        errors: errors
      });
    }

    // Response
    if (isArray) {
      // ส่งหลาย devices
      const updatedCount = updatedDevices.filter(d => d.action === 'updated').length;
      const noChangesCount = updatedDevices.filter(d => d.action === 'no_changes').length;

      res.status(200).json({
        success: true,
        message: `Updated asset state successfully ${updatedCount} records${noChangesCount > 0 ? ` (no changes ${noChangesCount} records)` : ''}${errors.length > 0 ? ` (errors ${errors.length} records)` : ''}`,
        count: updatedDevices.length,
        updated: updatedCount,
        noChanges: noChangesCount,
        data: updatedDevices,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      // ส่ง device เดียว
      res.status(200).json({
        success: true,
        message: updatedDevices[0].action === 'updated' ? 'Asset state updated successfully' : 'Asset state no changes',
        data: updatedDevices[0]
      });
    }
  } catch (error) {
    console.error('Error updating asset state:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating asset state',
      error: error.message
    });
  }
};

// PUT - แก้ไขข้อมูล Device
const updateDevice = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      Asset_State,
      serial,
      CI_Name,
      Asset_Number,
      PR_No,
      Vendor,
      Project_purchase,
      SLid,
      PO_No,
      Loan_Start,
      Request_Date,
      Refer_SOF,
      Refer_Ticket,
      Assigned_Service,
      Reason,
      Dtypeid,
      DeRoleid,
      Waranty_start,
      Waranty_end,
    } = req.body;

    const hasUpdate = Asset_State !== undefined || serial !== undefined ||
      CI_Name !== undefined || Asset_Number !== undefined ||
      PR_No !== undefined || Vendor !== undefined ||
      Project_purchase !== undefined || SLid !== undefined ||
      PO_No !== undefined || Loan_Start !== undefined || Request_Date !== undefined ||
      Refer_SOF !== undefined || Refer_Ticket !== undefined ||
      Assigned_Service !== undefined || Reason !== undefined ||
      Dtypeid !== undefined || DeRoleid !== undefined ||
      Waranty_start !== undefined || Waranty_end !== undefined;

    if (!hasUpdate) {
      return res.status(400).json({
        success: false,
        message: 'Please provide data to update'
      });
    }

    // ตรวจสอบว่า Device มีอยู่จริงหรือไม่ และดึงข้อมูลเดิม
    const checkSql = 'SELECT Did, Asset_State FROM devices WHERE Did = ?';
    const [existing] = await db.execute(checkSql, [id]);

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    const vis = tenantClause(req, 'devices');
    const [visible] = await db.execute(
      `SELECT Did FROM devices WHERE Did = ?${vis.sql}`,
      [id, ...vis.params]
    );
    if (visible.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    const oldAssetState = existing[0].Asset_State;

    // สร้าง SQL query แบบ dynamic
    const updates = [];
    const values = [];
    const changedFields = {};

    if (Asset_State !== undefined) {
      updates.push('Asset_State = ?');
      values.push(Asset_State);
      changedFields.Asset_State = Asset_State;
    }
    if (SLid !== undefined) {
      updates.push('SLid = ?');
      values.push(SLid);
      changedFields.SLid = SLid;
    }
    if (serial !== undefined) {
      updates.push('serial = ?');
      values.push(serial);
      changedFields.serial = serial;
    }
    if (CI_Name !== undefined) {
      updates.push('CI_Name = ?');
      values.push(CI_Name);
      changedFields.CI_Name = CI_Name;
    }
    if (Asset_Number !== undefined) {
      updates.push('Asset_Number = ?');
      values.push(Asset_Number);
      changedFields.Asset_Number = Asset_Number;
    }
    if (PR_No !== undefined) {
      updates.push('PR_No = ?');
      values.push(PR_No);
      changedFields.PR_No = PR_No;
    }
    if (Vendor !== undefined) {
      updates.push('Vendor = ?');
      values.push(Vendor);
      changedFields.Vendor = Vendor;
    }
    if (Project_purchase !== undefined) {
      updates.push('Project_purchase = ?');
      values.push(Project_purchase);
      changedFields.Project_purchase = Project_purchase;
    }
    if (PO_No !== undefined) {
      updates.push('PO_No = ?');
      values.push(PO_No);
      changedFields.PO_No = PO_No;
    }
    if (Loan_Start !== undefined) {
      updates.push('Loan_Start = ?');
      values.push(Loan_Start);
      changedFields.Loan_Start = Loan_Start;
    }
    if (Request_Date !== undefined) {
      updates.push('Request_Date = ?');
      values.push(Request_Date);
      changedFields.Request_Date = Request_Date;
    }
    if (Refer_SOF !== undefined) {
      changedFields.Refer_SOF = Refer_SOF;
    }
    if (Refer_Ticket !== undefined) {
      updates.push('Refer_Ticket = ?');
      values.push(Refer_Ticket);
      changedFields.Refer_Ticket = Refer_Ticket;
    }
    if (Assigned_Service !== undefined) {
      updates.push('Assigned_Service = ?');
      values.push(Assigned_Service);
      changedFields.Assigned_Service = Assigned_Service;
    }
    if (Reason !== undefined) {
      updates.push('Reason = ?');
      values.push(Reason);
      changedFields.Reason = Reason;
    }
    if (Dtypeid !== undefined) {
      updates.push('Dtypeid = ?');
      values.push(Dtypeid);
      changedFields.Dtypeid = Dtypeid;
    }
    if (DeRoleid !== undefined) {
      updates.push('DeRoleid = ?');
      values.push(DeRoleid);
      changedFields.DeRoleid = DeRoleid;
    }
    if (Waranty_start !== undefined) {
      updates.push('Waranty_start = ?');
      values.push(Waranty_start);
      changedFields.Waranty_start = Waranty_start;
    }
    if (Waranty_end !== undefined) {
      updates.push('Waranty_end = ?');
      values.push(Waranty_end);
      changedFields.Waranty_end = Waranty_end;
    }

    if (updates.length === 0 && Refer_SOF === undefined) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    if (updates.length > 0) {
      values.push(id);
      const sql = `UPDATE devices SET ${updates.join(', ')} WHERE Did = ?`;
      await db.execute(sql, values);
    }

    if (Refer_SOF !== undefined) {
      let slidForSof = SLid;
      if (slidForSof == null) {
        const [slRows] = await db.execute('SELECT SLid FROM devices WHERE Did = ?', [id]);
        slidForSof = slRows[0]?.SLid;
      }
      if (slidForSof != null) {
        await applyReferSofToSiteLocation(db, slidForSof, Refer_SOF);
      }
    }

    // ดึงข้อมูลที่อัพเดทแล้วมาแสดง (พร้อม JOIN)
    const [updated] = await db.execute(
      `SELECT Did, Asset_State, serial, CI_Name, Asset_Number, PR_No, Vendor, 
       devices.SLid, L.Location2, PO_No, Loan_Start, Request_Date, ${deviceSofSelect('sl')}, 
       Refer_Ticket, devices.Assigned_Service, Reason, devices.Dtypeid, 
       device_type.model, manufacturer.name as manufacturername, sites.Name as Sitename 
       FROM devices
       LEFT JOIN device_type ON devices.Dtypeid = device_type.Dtypeid
       LEFT JOIN manufacturer ON device_type.Mid = manufacturer.Mid
       LEFT JOIN sites_location sl ON devices.SLid = sl.SLid
       LEFT JOIN sites ON sl.Sid = sites.Sid
       LEFT JOIN location L ON sl.lid = L.lid
       WHERE devices.Did = ?`,
      [id]
    );

    res.status(200).json({
      success: true,
      message: 'Device updated successfully',
      data: updated[0]
    });
  } catch (error) {
    console.error('Error updating device:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating device',
      error: error.message
    });
  }
};

// DELETE - ลบ Device
const deleteDevice = async (req, res) => {
  try {
    const { id } = req.params;

    // ตรวจสอบว่า Device มีอยู่จริงหรือไม่
    const vis = tenantClause(req, 'devices');
    const [existing] = await db.execute(
      `SELECT Did, CI_Name FROM devices WHERE Did = ?${vis.sql}`,
      [id, ...vis.params]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    // ลบข้อมูล
    const sql = 'DELETE FROM devices WHERE Did = ?';
    await db.execute(sql, [id]);

    res.status(200).json({
      success: true,
      message: 'Device deleted successfully',
      data: {
        id: existing[0].Did,
        CI_Name: existing[0].CI_Name
      }
    });
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({
      success: false,
    message: 'Error deleting device',
      error: error.message
    });
  }
};

// GET - Dashboard Statistics
const getDashboard = async (req, res) => {
  try {
    const tfD = tenantClause(req, 'd');
    const tf = tenantClause(req, 'devices');
    const siteStatsSql = `SELECT s.Name AS site_name, COUNT(*) AS total
                          FROM devices d
                          JOIN sites_location sl ON d.SLid = sl.SLid
                          JOIN sites s ON sl.Sid = s.Sid
                          WHERE 1=1 ${tfD.sql}
                          GROUP BY s.Name`;
    const [siteStats] = await db.execute(siteStatsSql, tfD.params);

    // 2. จำนวน Devices ทั้งหมด
    const totalDevicesSql = `SELECT COUNT(*) AS total_devices FROM devices WHERE 1=1 ${tf.sql}`;
    const [totalDevicesResult] = await db.execute(totalDevicesSql, tf.params);
    const totalDevices = totalDevicesResult[0].total_devices;

    // 3. จำนวน Devices ต่อ Asset_State
    const assetStateSql = `SELECT Asset_State, COUNT(*) AS total
                           FROM devices
                           WHERE 1=1 ${tf.sql}
                           GROUP BY Asset_State`;
    const [assetStateStats] = await db.execute(assetStateSql, tf.params);

    // 4. จำนวน Devices ที่ available (Request_Date IS NULL)
    const availableSql = `SELECT COUNT(*) AS available_devices
                         FROM devices
                         WHERE Request_Date IS NULL ${tf.sql}`;
    const [availableResult] = await db.execute(availableSql, tf.params);
    const availableDevices = availableResult[0].available_devices;

    // 5. จำนวน Devices ที่ requested (Request_Date IS NOT NULL)
    const requestedSql = `SELECT COUNT(*) AS requested_devices
                         FROM devices
                         WHERE Request_Date IS NOT NULL ${tf.sql}`;
    const [requestedResult] = await db.execute(requestedSql, tf.params);
    const requestedDevices = requestedResult[0].requested_devices;

    // 6. จำนวน Devices ต่อ Model
    const modelStatsSql = `SELECT dt.model, COUNT(*) AS total
                          FROM devices d
                          JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
                          WHERE 1=1 ${tfD.sql}
                          GROUP BY dt.model`;
    const [modelStats] = await db.execute(modelStatsSql, tfD.params);

    // 7. จำนวน Devices ต่อ manufacturer
    const manufacturerStatsSql = `SELECT m.name AS manufacturer, COUNT(*) AS total
                                 FROM devices d
                                 JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
                                 JOIN manufacturer m ON dt.Mid = m.Mid
                                 WHERE 1=1 ${tfD.sql}
                                 GROUP BY m.name`;
    const [manufacturerStats] = await db.execute(manufacturerStatsSql, tfD.params);

    res.status(200).json({
      success: true,
      data: {
        totalDevices: totalDevices,
        availableDevices: availableDevices,
        requestedDevices: requestedDevices,
        siteStats: siteStats,
        assetStateStats: assetStateStats,
        modelStats: modelStats,
        manufacturerStats: manufacturerStats
      }
    });
  } catch (error) {
    console.error('Error getting dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting dashboard',
      error: error.message
    });
  }
};

// GET - ดึงข้อมูล Devices แยกตาม Model (พร้อม Asset_State breakdown และ manufacturer)
const getDevicesByModel = async (req, res) => {
  try {
    const tf = tenantClause(req, 'd');
    // ดึงข้อมูล model, manufacturer, และจำนวนทั้งหมด
    const modelSql = `SELECT 
                      dt.model,
                      m.name AS manufacturername,
                      COUNT(*) AS total
                      FROM devices d
                      JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
                      JOIN manufacturer m ON dt.Mid = m.Mid
                      WHERE 1=1 ${tf.sql}
                      GROUP BY dt.model, m.name
                      ORDER BY dt.model`;

    const [modelRows] = await db.execute(modelSql, tf.params);

    // ดึงข้อมูล Asset_State breakdown สำหรับแต่ละ model
    const assetStateSql = `SELECT 
                          dt.model,
                          d.Asset_State,
                          COUNT(*) AS count
                          FROM devices d
                          JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
                          WHERE 1=1 ${tf.sql}
                          GROUP BY dt.model, d.Asset_State
                          ORDER BY dt.model, d.Asset_State`;

    const [assetStateRows] = await db.execute(assetStateSql, tf.params);

    // รวมข้อมูล Asset_State เข้ากับแต่ละ model
    const result = modelRows.map(model => {
      const assetStates = assetStateRows
        .filter(row => row.model === model.model)
        .map(row => ({
          Asset_State: row.Asset_State,
          count: row.count
        }));

      return {
        model: model.model,
        manufacturername: model.manufacturername,
        total: model.total,
        assetStates: assetStates
      };
    });

    res.status(200).json({
      success: true,
      count: result.length,
      data: result
    });
  } catch (error) {
    console.error('Error getting devices by model:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices by model',
      error: error.message
    });
  }
};

// GET - รายการ Vendor สำหรับ dropdown (DISTINCT จาก devices.Project_purchase, ORDER BY Project_purchase ASC)
// ถ้า Project_purchase ไม่มีใช้ Vendor แทน
const getVendors = async (req, res) => {
  try {
    const tf = tenantClause(req, 'devices');
    let rows;
    try {
      [rows] = await db.execute(
        `SELECT DISTINCT Project_purchase AS name FROM devices
         WHERE Project_purchase IS NOT NULL AND TRIM(Project_purchase) != ''
         ${tf.sql}
         ORDER BY Project_purchase ASC`,
        tf.params
      );
    } catch (e) {
      [rows] = await db.execute(
        `SELECT DISTINCT Vendor AS name FROM devices
         WHERE Vendor IS NOT NULL AND TRIM(Vendor) != ''
         ${tf.sql}
         ORDER BY Vendor ASC`,
        tf.params
      );
    }
    res.status(200).json({ success: true, data: rows.map((r) => r.name) });
  } catch (error) {
    console.error('Error getting vendors:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting vendors',
      error: error.message
    });
  }
};

// GET - ดึง Devices ตาม site_id (= SLid, sites_location) สำหรับ Contract / Asset Binding
// GET - ดึง unique SOF จาก sites_location (ผ่าน devices.SLid)
const getReferSOFList = async (req, res) => {
  try {
    const [rows] = await db.execute(REFER_SOF_DROPDOWN_SQL);
    res.status(200).json({ 
      success: true, 
      data: rows.map(r => r.refer_sof).filter(Boolean)
    });
  } catch (error) {
    console.error('Error getting Refer_SOF list:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting Refer_SOF list',
      error: error.message
    });
  }
};

// GET - ดึง unique Assigned_Service values จาก Devices table (สำหรับ dropdown Service ใน Add Contract)
const getAssignedServicesList = async (req, res) => {
  try {
    const tf = tenantClause(req, 'devices');
    const [rows] = await db.execute(
      `SELECT DISTINCT Assigned_Service AS assigned_service
       FROM devices
       WHERE Assigned_Service IS NOT NULL AND TRIM(Assigned_Service) != ''
       ${tf.sql}
       ORDER BY Assigned_Service ASC`,
      tf.params
    );
    res.status(200).json({
      success: true,
      data: rows.map(r => (r.assigned_service != null ? String(r.assigned_service).trim() : '')).filter(Boolean)
    });
  } catch (error) {
    console.error('Error getting Assigned_Service list:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting Assigned_Service list',
      error: error.message
    });
  }
};

// GET - ดึง Devices ตาม Refer_SOF และ Site — รองรับ sid (sites.Sid) หรือ site_id (SLid)
// ทั้ง sid และ site_id: SOF ตรง + ขอบเขต site/location — ไม่กรอง Asset_State
const getDevicesBySOFAndSite = async (req, res) => {
  try {
    const referSOF = req.query.refer_sof;
    const siteId = req.query.site_id;
    const sid = req.query.sid;
    
    if (!referSOF) {
      return res.status(400).json({
        success: false,
        message: 'Please provide refer_sof'
      });
    }
    
    if (!siteId && !sid) {
      return res.status(400).json({
        success: false,
        message: 'Please provide sid (site id) or site_id (SLid)'
      });
    }
    const referSOFTrim = normalizeReferSofKey(referSOF) || '0';
  
    const sofMatch = sofMatchWhere('sl');
    const sofSelect = deviceSofSelect('sl');
    const tf = tenantClause(req, 'd');
    let rows;
    if (sid) {
      const sidNum = parseInt(sid, 10);
      if (isNaN(sidNum)) {
        return res.status(400).json({ success: false, message: 'sid is not valid' });
      }
      [rows] = await db.execute(
        `SELECT d.Did, d.CI_Name, d.Asset_Number, d.Asset_State, d.serial, d.SLid, d.Dtypeid, d.DeRoleid, ${sofSelect}, dt.model, dr.name as roleName, m.name as manufacturername, L.Location2
         FROM devices d
         LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
         LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
         LEFT JOIN manufacturer m ON dt.Mid = m.Mid
         INNER JOIN sites_location sl ON d.SLid = sl.SLid
         LEFT JOIN location L ON sl.lid = L.lid
         WHERE sl.Sid = ? AND ${sofMatch}${tf.sql}
         ORDER BY COALESCE(d.CI_Name, d.Asset_Number, d.Did) ASC`,
        [sidNum, referSOF, referSOFTrim, ...tf.params]
      );
    } else {
      [rows] = await db.execute(
        `SELECT d.Did, d.CI_Name, d.Asset_Number, d.Asset_State, d.serial, d.SLid, d.Dtypeid, d.DeRoleid, ${sofSelect}, dt.model, dr.name as roleName, m.name as manufacturername, L.Location2
         FROM devices d
         LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
         LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
         LEFT JOIN manufacturer m ON dt.Mid = m.Mid
         INNER JOIN sites_location sl ON d.SLid = sl.SLid
         LEFT JOIN location L ON sl.lid = L.lid
         WHERE d.SLid = ? AND ${sofMatch}${tf.sql}
         ORDER BY COALESCE(d.CI_Name, d.Asset_Number, d.Did) ASC`,
        [siteId, referSOF, referSOFTrim, ...tf.params]
      );
    }
    
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting devices by SOF and site:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices by SOF and site',
      error: error.message
    });
  }
};

// GET - ดึง Devices ตาม contract_id (=== SLid) และ slid (Site+Location)
// เครื่องผูกสัญญาผ่าน devices.SLid
/**
 * GET ?contract_id=&refer_sof=
 * Distinct SLid + Location2 for devices on this contract whose Refer_SOF matches (same rules as by-sof-and-site).
 * Used by schedule import hints: only locations that actually exist for this SOF on the contract.
 */
const getImportLocation2HintsByContractAndSof = async (req, res) => {
  try {
    const contractId = req.query.contract_id;
    const referSOF = req.query.refer_sof;
    if (!contractId || referSOF == null || String(referSOF).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Please provide contract_id and refer_sof',
      });
    }
    const referSOFTrim = normalizeReferSofKey(referSOF) || '0';
    const sofMatch = sofMatchWhere('sl');
    const slid = parseInt(contractId, 10);
    const tf = tenantClause(req, 'd');
    const [rows] = await db.execute(
      `SELECT DISTINCT d.SLid AS SLid,
              TRIM(L.Location2) AS Location2
       FROM devices d
       INNER JOIN sites_location sl ON d.SLid = sl.SLid
       LEFT JOIN location L ON sl.lid = L.lid
       WHERE d.SLid = ?
         AND ${sofMatch}
         AND TRIM(COALESCE(L.Location2, '')) != ''
         ${tf.sql}
       ORDER BY Location2 ASC, d.SLid ASC`,
      [slid, referSOF, referSOFTrim, ...tf.params]
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting import Location2 hints:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting import Location2 hints',
      error: error.message,
    });
  }
};

const getDevicesByContractAndSite = async (req, res) => {
  try {
    const contractId = req.query.contract_id;
    const slid = req.query.slid || req.query.site_id;

    if (!contractId || !slid) {
      return res.status(400).json({
        success: false,
        message: 'Please provide contract_id and slid (site_id)'
      });
    }

    const contractSlid = parseInt(contractId, 10);
    const siteSlid = parseInt(slid, 10);
    const filterSlid = !Number.isNaN(siteSlid) ? siteSlid : contractSlid;
    const tf = tenantClause(req, 'd');
    const [rows] = await db.execute(
      `SELECT d.Did, d.CI_Name, d.Asset_Number, d.Asset_State, d.serial, d.SLid, d.Dtypeid, d.DeRoleid, ${deviceSofSelect('sl')}, dt.model, dr.name as roleName, m.name as manufacturername, L.Location2
       FROM devices d
       LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
       LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
       LEFT JOIN manufacturer m ON dt.Mid = m.Mid
       LEFT JOIN sites_location sl ON d.SLid = sl.SLid
       LEFT JOIN location L ON sl.lid = L.lid
       WHERE d.SLid = ?${tf.sql}
       ORDER BY COALESCE(d.CI_Name, d.Asset_Number, d.Did) ASC`,
      [filterSlid, ...tf.params]
    );

    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting devices by contract and site:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices by contract and site',
      error: error.message
    });
  }
};

// GET - ดึง Devices ตาม Serial (หลายตัว คั่นด้วย comma) สำหรับ Import Contract
// query: serials=FGL2314A91L,FGL2314A92L หรือ serials=FGL2314A91L
const getDevicesBySerials = async (req, res) => {
  try {
    const raw = req.query.serials || req.query.serial || '';
    const list = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }
    const placeholders = list.map(() => 'TRIM(serial) = ?').join(' OR ');
    const tf = tenantClause(req, 'devices');
    const sql = `SELECT Did, serial FROM devices WHERE (${placeholders})${tf.sql}`;
    const [rows] = await db.execute(sql, [...list, ...tf.params]);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting devices by serials:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices by serials',
      error: error.message
    });
  }
};

// GET - ดึง Devices ที่ยังไม่มี SOF (Refer_SOF เป็น NULL, '' หรือ 'Not Assigned') และยังไม่มี contract
// รองรับ sid (sites.Sid) หรือ site_id (SLid); ถ้าไม่มี query = คลังตามชื่อ DEFAULT_IN_STORE_SITE_NAME — เฉพาะ In Store (SOF ใหม่ในหน้า contract)
const getDevicesBySiteNoSOF = async (req, res) => {
  try {
    const siteId = req.query.site_id;
    const sid = req.query.sid;
    let sql, params;
    const noSofCondition = noSofWhere('sl', 'd');
    const sofSelect = deviceSofSelect('sl');
    const notInContract = `(d.SLid IS NULL OR sl.SLid IS NULL OR sl.status = 'draft' OR ${noSofCondition})`;
    const inStore = `(LOWER(TRIM(COALESCE(d.Asset_State,''))) = 'in store')`;
    const tf = tenantClause(req, 'd');
    
    if (sid) {
      const sidNum = parseInt(sid, 10);
      if (isNaN(sidNum)) {
        return res.status(400).json({ success: false, message: 'sid is not valid' });
      }
      sql = `SELECT d.Did, d.CI_Name, d.Asset_Number, d.Asset_State, d.serial, d.SLid, d.Dtypeid, d.DeRoleid, ${sofSelect}, dt.model, dr.name as roleName, m.name as manufacturername
             FROM devices d
             LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
             LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
             LEFT JOIN manufacturer m ON dt.Mid = m.Mid
             INNER JOIN sites_location sl ON d.SLid = sl.SLid
             WHERE sl.Sid = ?
               AND ${inStore}
               AND ${noSofCondition}
               AND (${notInContract})
             ${tf.sql}
             ORDER BY COALESCE(d.CI_Name, d.Asset_Number, d.Did) ASC`;
      params = [sidNum, ...tf.params];
    } else if (siteId) {
      sql = `SELECT d.Did, d.CI_Name, d.Asset_Number, d.Asset_State, d.serial, d.SLid, d.Dtypeid, d.DeRoleid, ${sofSelect}, dt.model, dr.name as roleName, m.name as manufacturername
             FROM devices d
             LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
             LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
             LEFT JOIN manufacturer m ON dt.Mid = m.Mid
             INNER JOIN sites_location sl ON d.SLid = sl.SLid
             WHERE d.SLid = ?
               AND ${inStore}
               AND ${noSofCondition}
               AND (${notInContract})
             ${tf.sql}
             ORDER BY COALESCE(d.CI_Name, d.Asset_Number, d.Did) ASC`;
      params = [siteId, ...tf.params];
    } else {
      sql = `SELECT d.Did, d.CI_Name, d.Asset_Number, d.Asset_State, d.serial, d.SLid, d.Dtypeid, d.DeRoleid, ${sofSelect}, dt.model, dr.name as roleName, m.name as manufacturername
             FROM devices d
             LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
             LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
             LEFT JOIN manufacturer m ON dt.Mid = m.Mid
             INNER JOIN sites_location sl ON d.SLid = sl.SLid
             INNER JOIN sites s_instore ON sl.Sid = s_instore.Sid
               AND LOWER(TRIM(s_instore.Name)) = LOWER(TRIM(?))
             WHERE ${inStore}
               AND ${noSofCondition}
               AND (${notInContract})
             ${tf.sql}
             ORDER BY COALESCE(d.CI_Name, d.Asset_Number, d.Did) ASC`;
      params = [DEFAULT_IN_STORE_SITE_NAME, ...tf.params];
    }
    
    const [rows] = await db.execute(sql, params);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting devices (no SOF):', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices (no SOF)',
      error: error.message
    });
  }
};

// GET - ดึง Devices ที่ยังไม่มี SOF และสถานะ In Store ภายใต้คลัง (sites.Name ตรง DEFAULT_IN_STORE_SITE_NAME)
// รองรับ contract_id (optional): ยกเว้น device ที่อยู่ในสัญญา official อื่น (devices.SLid)
const getDevicesNoSofInStore = async (req, res) => {
  try {
    const contractId = req.query.contract_id;
    const noSofCondition = noSofWhere('sl', 'd');
    const sofSelect = deviceSofSelect('sl');
    const inStoreCondition = `(LOWER(TRIM(COALESCE(d.Asset_State,''))) = 'in store')`;
    const tf = tenantClause(req, 'd');
    const onOtherContract = `(
      sl.SLid IS NOT NULL
      AND sl.status = 'official'
      AND sl.SOF IS NOT NULL AND TRIM(sl.SOF) != ''
    )`;
    let contractExclusionCondition = '';
    const params = [DEFAULT_IN_STORE_SITE_NAME];
    if (contractId) {
      const cid = parseInt(contractId, 10);
      if (!isNaN(cid)) {
        contractExclusionCondition = `
          AND NOT (${onOtherContract} AND sl.SLid != ?)
        `;
        params.push(cid);
      }
    } else {
      contractExclusionCondition = `
        AND NOT (${onOtherContract})
      `;
    }
    const sql = `SELECT d.Did, d.CI_Name, d.Asset_Number, d.Asset_State, d.serial, d.SLid, d.Dtypeid, d.DeRoleid, ${sofSelect}, dt.model, dr.name as roleName, m.name as manufacturername
                 FROM devices d
                 LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
                 LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
                 LEFT JOIN manufacturer m ON dt.Mid = m.Mid
                 INNER JOIN sites_location sl ON d.SLid = sl.SLid
                 INNER JOIN sites s_instore ON sl.Sid = s_instore.Sid
                   AND LOWER(TRIM(s_instore.Name)) = LOWER(TRIM(?))
                 WHERE ${noSofCondition}
                   AND ${inStoreCondition}
                   ${contractExclusionCondition}
                   ${tf.sql}
                 ORDER BY COALESCE(d.CI_Name, d.Asset_Number, d.Did) ASC`;
    const [rows] = await db.execute(sql, [...params, ...tf.params]);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting devices (no SOF, In Store):', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices (no SOF, In Store)',
      error: error.message
    });
  }
};

const getDevicesBySite = async (req, res) => {
  try {
    const siteId = req.query.site_id;
    if (!siteId) {
      return res.status(400).json({
        success: false,
        message: 'Please provide site'
      });
    }
    const tf = tenantClause(req, 'devices');
    // TccStock: devices.SLid -> sites_location.SLid
    const [rows] = await db.execute(
      `SELECT Did, CI_Name, Asset_Number, Asset_State, serial, SLid, Dtypeid, DeRoleid
       FROM devices
       WHERE SLid = ?${tf.sql}
       ORDER BY COALESCE(CI_Name, Asset_Number, Did) ASC`,
      [siteId, ...tf.params]
    );
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting devices by site:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices by site',
      error: error.message
    });
  }
};

// GET - ดึง Devices ตาม Asset_State (เช่น In Store, In Store On Site) สำหรับ MA
const getDevicesByAssetState = async (req, res) => {
  try {
    const statesParam = req.query.states || 'In Store';
    const search = req.query.search || '';
    const states = statesParam
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (states.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide states (at least 1 value)'
      });
    }

    const placeholders = states.map(() => '?').join(', ');
    const tf = tenantClause(req, 'devices');
    const params = [...states];
    let searchSql = '';

    if (search) {
      const searchPattern = `%${search}%`;
      searchSql = `AND (
        CI_Name LIKE ? OR
        Asset_Number LIKE ? OR
        serial LIKE ?
      )`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    const sql = `
      SELECT Did, CI_Name, Asset_Number, Asset_State, serial, SLid, Dtypeid, DeRoleid
      FROM devices
      WHERE Asset_State IN (${placeholders})
      ${searchSql}
      ${tf.sql}
      ORDER BY COALESCE(CI_Name, Asset_Number, Did) ASC
      LIMIT 200
    `;

    const [rows] = await db.execute(sql, [...params, ...tf.params]);
    res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error('Error getting devices by asset state:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting devices by asset state',
      error: error.message,
      sqlState: error.sqlState,
      errno: error.errno
    });
  }
};

// GET - ดึง Devices In Store ทุก SLid (ทุก lid) ใต้ site คลัง Bangna — ไม่กรอง Location2 / Dtypeid / DeRoleid
const getReplacementDevices = async (req, res) => {
  try {
    const warehouseSlids = await resolveAllInStoreSlids(db);
    if (warehouseSlids.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }
    const tf = tenantClause(req, 'd');
    const slidPlaceholders = warehouseSlids.map(() => '?').join(',');
    const sql = `
      SELECT 
        d.Did,
        d.CI_Name,
        d.Asset_Number,
        d.serial,
        d.Asset_State,
        d.Dtypeid,
        d.DeRoleid,
        d.SLid,
        s.Name AS SiteName,
        IFNULL(l.Location2, '') AS Location2,
        dt.model,
        dr.name AS roleName
      FROM devices d
      INNER JOIN sites_location sl ON d.SLid = sl.SLid
      INNER JOIN sites s ON sl.Sid = s.Sid
      LEFT JOIN location l ON sl.lid = l.lid
      LEFT JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
      LEFT JOIN device_role dr ON d.DeRoleid = dr.DeRoleid
      WHERE d.SLid IN (${slidPlaceholders})
        AND (LOWER(TRIM(COALESCE(d.Asset_State, ''))) = 'in store')
      ${tf.sql}
      ORDER BY d.CI_Name ASC, d.Asset_Number ASC
    `;

    const [rows] = await db.execute(sql, [...warehouseSlids, ...tf.params]);

    res.status(200).json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error('Error getting replacement devices:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting replacement devices',
      error: error.message
    });
  }
};

// GET - ดูประวัติการเปลี่ยนแปลงของ Devices ทั้งหมด (พร้อมข้อมูล Device)
const viewDeviceHistory = async (req, res) => {
  try {
    // ดึง query parameters
    const page = parseInt(req.query.page) || 1; // หน้าปัจจุบัน (default: 1)
    const limit = parseInt(req.query.limit) || 50; // จำนวน records ต่อหน้า (default: 50)
    const action = req.query.action; // Filter by action (INSERT, UPDATE, ASSET_STATE_CHANGE)
    const deviceId = req.query.deviceId; // Filter by Device ID
    const search = req.query.search || ''; // คำค้นหา (optional)
    const offset = (page - 1) * limit; // คำนวณ offset

    // สร้าง WHERE conditions
    let whereConditions = [];
    let params = [];

    // Filter by action
    if (action && ['INSERT', 'UPDATE', 'ASSET_STATE_CHANGE'].includes(action.toUpperCase())) {
      whereConditions.push('dh.Action = ?');
      params.push(action.toUpperCase());
    }

    // Filter by device ID
    if (deviceId) {
      whereConditions.push('dh.Did = ?');
      params.push(deviceId);
    }

    // Search condition
    if (search) {
      const searchPattern = `%${search}%`;
      whereConditions.push(`(
        d.CI_Name LIKE ? OR 
        d.Asset_Number LIKE ? OR 
        d.serial LIKE ? OR 
        dt.model LIKE ? OR 
        m.name LIKE ? OR
        s.Name LIKE ?
      )`);
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const countSql = `SELECT COUNT(*) as total 
                      FROM devices_history dh
                      JOIN devices d ON dh.Did = d.Did
                      JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
                      JOIN manufacturer m ON dt.Mid = m.Mid
                      LEFT JOIN sites_location sl ON d.SLid = sl.SLid
                      LEFT JOIN sites s ON sl.Sid = s.Sid
                      ${whereClause}`;
    const [countResult] = await db.execute(countSql, params);
    const totalRecords = countResult[0].total;
    const totalPages = Math.ceil(totalRecords / limit);

    // ดึงข้อมูลประวัติพร้อมข้อมูล Device
    const sql = `SELECT 
                  dh.Historyid,
                  dh.Did,
                  dh.Action,
                  dh.Old_Value,
                  dh.New_Value,
                  dh.Changed_Fields,
                  dh.Created_At,
                  dh.User,
                  d.Asset_State,
                  d.serial,
                  d.CI_Name,
                  d.Asset_Number,
                  d.PR_No,
                  d.Vendor,
                  d.Project,
                  d.Location2,
                  dt.model,
                  m.name AS manufacturername,
                  s.Name AS Sitename
                  FROM devices_history dh
                  JOIN devices d ON dh.Did = d.Did
                  JOIN device_type dt ON d.Dtypeid = dt.Dtypeid
                  JOIN manufacturer m ON dt.Mid = m.Mid
                  LEFT JOIN sites s ON d.Sid = s.Sid
                  ${whereClause}
                  ORDER BY dh.Created_At DESC
                  LIMIT ? OFFSET ?`;

    const [rows] = await db.execute(sql, [...params, limit, offset]);

    const history = rows.map(row => ({
      logId: row.log_id,
      actionType: row.action_type,
      changedAt: row.changed_at,
      Did: row.Did,
      description: row.Description,
      Device: {
        Asset_State: row.Asset_State,
        serial: row.serial,
        CI_Name: row.CI_Name,
        Asset_Number: row.Asset_Number,
        PR_No: row.PR_No,
        Vendor: row.Vendor,
        Project_purchase: row.Project_purchase,
        model: row.model,
        manufacturername: row.manufacturername,
        Sitename: row.Sitename
      }
    }));

    res.status(200).json({
      success: true,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalRecords: totalRecords,
        recordsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      filters: {
        action: action || null,
        deviceId: deviceId || null,
        search: search || null
      },
      count: history.length,
      data: history
    });
  } catch (error) {
    console.error('Error viewing device history:', error);
    res.status(500).json({
      success: false,
      message: 'Error viewing device history',
      error: error.message
    });
  }
};

// GET - ดึงประวัติการเปลี่ยนแปลงของ Device
const getDeviceHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.query; // Filter by action (INSERT, UPDATE, ASSET_STATE_CHANGE)

    // ตรวจสอบว่า Device มีอยู่จริงหรือไม่
    const checkSql = 'SELECT Did FROM devices WHERE Did = ?';
    const [existing] = await db.execute(checkSql, [id]);

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    // สร้าง WHERE condition สำหรับ filter action
    let actionCondition = '';
    let params = [id];

    if (action && ['INSERT', 'UPDATE', 'ASSET_STATE_CHANGE'].includes(action.toUpperCase())) {
      actionCondition = 'AND Action = ?';
      params.push(action.toUpperCase());
    }

    // ดึงประวัติ
    const sql = `SELECT 
                  Historyid, Did, Action, Old_Value, New_Value, 
                  Changed_Fields, Created_At, User
                  FROM devices_history
                  WHERE Did = ? ${actionCondition}
                  ORDER BY Created_At DESC`;

    const [rows] = await db.execute(sql, params);

    const history = rows.map(row => ({
      logId: row.log_id,
      actionType: row.action_type,
      changedAt: row.changed_at,
      Did: row.Did,
      Asset_State: row.Asset_State,
      serial: row.serial,
      CI_Name: row.CI_Name,
      Asset_Number: row.Asset_Number,
      description: row.Description
    }));

    res.status(200).json({
      success: true,
      count: history.length,
      data: history
    });
  } catch (error) {
    console.error('Error getting device history:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting device history',
      error: error.message
    });
  }
};
// GET - ดึง Devices พร้อม PM Information สำหรับ Asset & Site Database
const getDevicesWithPM = async (req, res) => {
  try {
    const tf = tenantClause(req, 'devices');
    console.log('[getDevicesWithPM] Request received:', {
      search: req.query.search,
      deviceType: req.query.DeRoleid,
      site: req.query.site

    });

    const search = req.query.search || '';
    const filterDeviceRole = req.query.deviceRole || '';
    const filterSite = req.query.site || '';

    // Build search condition
    let searchCondition = '';
    let searchParams = [];

    if (search) {
      const searchPattern = `%${search}%`;
      searchCondition = `AND (
        devices.CI_Name LIKE ? OR 
        devices.Asset_Number LIKE ? OR 
        devices.serial LIKE ? OR 
        devices.Vendor LIKE ?
      )`;
      searchParams = [searchPattern, searchPattern, searchPattern, searchPattern];
    }

    // Build device role filter
    let deviceRoleCondition = '';
    if (filterDeviceRole && filterDeviceRole !== 'all') {
      deviceRoleCondition = 'AND device_role.name = ?';
      searchParams.push(filterDeviceRole);
    }

    // Build site filter
    let siteCondition = '';
    if (filterSite && filterSite !== 'all') {
      siteCondition = 'AND sites.Name = ?';
      searchParams.push(filterSite);
    }
// yyyyyyydqw
     console.log('BBBB');

    // Devices on official contracts (devices.SLid → sites_location)
    const devicesSql = `
      SELECT DISTINCT
        devices.Did,
        devices.CI_Name,
        devices.Asset_Number,
        devices.Asset_State,
        devices.serial,
        devices.Vendor,
        devices.SLid,
        devices.Dtypeid,
        devices.DeRoleid,
        device_role.name AS DeviceRole,
        sites.Name AS SiteName,
        L.Location2 AS Province,
        sl.SLid AS contract_id
      FROM devices
      INNER JOIN sites_location sl ON devices.SLid = sl.SLid
        AND sl.status = 'official'
        AND sl.SOF IS NOT NULL AND TRIM(sl.SOF) != ''
      LEFT JOIN device_role ON devices.DeRoleid = device_role.DeRoleid
      LEFT JOIN sites ON sl.Sid = sites.Sid
      LEFT JOIN location L ON sl.lid = L.lid
      WHERE 1=1 
      ${tf.sql}
      ${searchCondition} 
      ${deviceRoleCondition} 
      ${siteCondition}
      ORDER BY devices.Did DESC`;
    const [devices] = await db.execute(devicesSql, [...tf.params, ...searchParams]);

    // Get all PM tasks (task_type = 'PM'); updated_at ใช้เป็น Last PM เมื่อ status = 'done'
    const [pmTasks] = await db.execute(`
      SELECT id, assets, start_date, end_date, status, engineers, notes, reschedule_note, updated_at
      FROM tasks
      WHERE task_type = 'PM'
      ORDER BY start_date DESC
    `);

    console.log(`[getDevicesWithPM] Found ${pmTasks.length} PM tasks`);

    // Process devices and attach PM information
    const devicesWithPM = devices.map(device => {
      const deviceId = device.Did;

      // Find last PM (most recent completed PM task that includes this device)
      let lastPM = null;
      let lastPMTask = null;

      // Find next PM (future PM task that includes this device)
      let nextPM = null;

      // Find all PM history for this device
      const pmHistory = [];

      for (const task of pmTasks) {
        if (!task.assets) continue;

        try {
          const assets = typeof task.assets === 'string' ? JSON.parse(task.assets) : task.assets;
          if (!Array.isArray(assets)) continue;

          // Check if this device is in the task's assets
          const deviceInTask = assets.some(asset => {
            if (typeof asset === 'object') {
              // Try multiple possible field names
              const assetId = asset.id || asset.Did || asset.deviceId || asset.device_id;
              return assetId && String(assetId) === String(deviceId);
            } else {
              // If asset is a number/string directly
              return String(asset) === String(deviceId);
            }
          });

          if (deviceInTask) {
            const taskDate = task.start_date || task.end_date;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const taskDateObj = new Date(taskDate);
            taskDateObj.setHours(0, 0, 0, 0);

            // Last PM: ใช้ updated_at จาก tasks เมื่อ status = 'done' (ถ้าไม่มีใช้ start_date/end_date)
            if (task.status === 'done') {
              const lastPMDate = task.updated_at || taskDate;
              if (!lastPM || new Date(lastPMDate) > new Date(lastPM)) {
                lastPM = lastPMDate;
                lastPMTask = task;
              }
            }

            // Next PM: งานที่วางไว้ในอนาคต และ status ต้องเป็น not-started
            if (taskDateObj >= today && (task.status || '') === 'not-started') {
              if (!nextPM || new Date(taskDate) < new Date(nextPM)) {
                nextPM = taskDate;
              }
            }

            // PM History
            const engineers = task.engineers ? (typeof task.engineers === 'string' ? JSON.parse(task.engineers) : task.engineers) : [];
            const technicianName = engineers.length > 0
              ? (engineers[0].name || engineers[0].id || 'Unknown')
              : 'Unassigned';

            const rn = task.reschedule_note != null && String(task.reschedule_note).trim() ? String(task.reschedule_note).trim() : '';
            const nn = task.notes != null && String(task.notes).trim() ? String(task.notes).trim() : '';
            const combinedNotes = [rn && `ย้ายนัด: ${rn}`, nn].filter(Boolean).join(' | ') || null;
            pmHistory.push({
              id: `PM${task.id}`,
              date: taskDate,
              status: task.status === 'done' ? 'Done' : task.status === 'working' ? 'In Progress' : task.status === 'stuck' ? 'Failed' : 'Scheduled',
              technician: technicianName,
              notes: combinedNotes
            });
          }
        } catch (error) {
          // Skip invalid JSON
          continue;
        }
      }

      // Sort PM history by date descending
      pmHistory.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      // Use device_role.name as device role
      const deviceRoleName = device.DeviceRole || 'Unknown';

      return {
        deviceId: `AS${String(device.Did).padStart(3, '0')}`,
        deviceName: device.CI_Name || device.Asset_Number || `Device ${device.Did}`,
        deviceRole: deviceRoleName,
        site: device.SiteName || 'Unknown',
        location: device.Province || 'N/A',
        vendor: device.Vendor || 'Unknown',
        model: device.DeviceRole || 'Unknown',
        serialNumber: device.serial || 'N/A',
        lastPM: lastPM,
        nextPM: nextPM,
        pmHistory: pmHistory,
        status: device.Asset_State === 'In Use' || device.Asset_State === 'In Store On Site' ? 'Active' :
          device.Asset_State === 'In Store' ? 'Inactive' :
            device.Asset_State === 'Maintenance' ? 'Maintenance' : 'Active',
      };
    });

    console.log(`[getDevicesWithPM] Processed ${devicesWithPM.length} devices with PM info`);

    // Calculate statistics from ALL devices (without search filter, but with role/site filters)
    // Query devices again without search condition for accurate statistics
    let statsParams = [];
    let statsDeviceRoleCondition = '';
    if (filterDeviceRole && filterDeviceRole !== 'all') {
      statsDeviceRoleCondition = 'AND device_role.name = ?';
      statsParams.push(filterDeviceRole);
    }
    let statsSiteCondition = '';
    if (filterSite && filterSite !== 'all') {
      statsSiteCondition = 'AND sites.Name = ?';
      statsParams.push(filterSite);
    }

    const statsSql = `
      SELECT DISTINCT
        devices.Did,
        devices.CI_Name,
        devices.Asset_Number,
        devices.Asset_State,
        devices.serial,
        devices.Vendor,
        devices.SLid,
        devices.Dtypeid,
        devices.DeRoleid,
        device_role.name AS DeviceRole,
        sites.Name AS SiteName,
        L.Location2 AS Province,
        sl.SLid AS contract_id
      FROM devices
      INNER JOIN sites_location sl ON devices.SLid = sl.SLid
        AND sl.status = 'official'
        AND sl.SOF IS NOT NULL AND TRIM(sl.SOF) != ''
      LEFT JOIN device_role ON devices.DeRoleid = device_role.DeRoleid
      LEFT JOIN sites ON sl.Sid = sites.Sid
      LEFT JOIN location L ON sl.lid = L.lid
      WHERE 1=1 
      ${tf.sql}
      ${statsDeviceRoleCondition} 
      ${statsSiteCondition}
      ORDER BY devices.Did DESC`;
    const [allDevicesForStats] = await db.execute(statsSql, [...tf.params, ...statsParams]);

    // Process all devices for statistics (same logic as devicesWithPM but without search filter)
    const allDevicesWithPM = allDevicesForStats.map(device => {
      const deviceId = device.Did;
      let lastPM = null;
      let nextPM = null;

      for (const task of pmTasks) {
        if (!task.assets) continue;
        try {
          const assets = typeof task.assets === 'string' ? JSON.parse(task.assets) : task.assets;
          if (!Array.isArray(assets)) continue;
          const deviceInTask = assets.some(asset => {
            if (typeof asset === 'object') {
              const assetId = asset.id || asset.Did || asset.deviceId || asset.device_id;
              return assetId && String(assetId) === String(deviceId);
            } else {
              return String(asset) === String(deviceId);
            }
          });

          if (deviceInTask) {
            const taskDate = task.start_date || task.end_date;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const taskDateObj = new Date(taskDate);
            taskDateObj.setHours(0, 0, 0, 0);

            // Last PM: ใช้ updated_at จาก tasks เมื่อ status = 'done'
            if (task.status === 'done') {
              const lastPMDate = task.updated_at || taskDate;
              if (!lastPM || new Date(lastPMDate) > new Date(lastPM)) {
                lastPM = lastPMDate;
              }
            }
            // Next PM: งานที่วางไว้ในอนาคต และ status ต้องเป็น not-started
            if (taskDateObj >= today && (task.status || '') === 'not-started') {
              if (!nextPM || new Date(taskDate) < new Date(nextPM)) {
                nextPM = taskDate;
              }
            }
          }
        } catch (error) {
          continue;
        }
      }

      const deviceRoleName = device.DeviceRole || 'Unknown';
      return {
        deviceId: `AS${String(device.Did).padStart(3, '0')}`,
        deviceName: device.CI_Name || device.Asset_Number || `Device ${device.Did}`,
        deviceRole: deviceRoleName,
        site: device.SiteName || 'Unknown',
        location: device.Province || 'N/A',
        vendor: device.Vendor || 'Unknown',
        model: device.DeviceRole || 'Unknown',
        serialNumber: device.serial || 'N/A',
        lastPM: lastPM,
        nextPM: nextPM,
        status: device.Asset_State === 'In Use' || device.Asset_State === 'In Store On Site' ? 'Active' :
          device.Asset_State === 'In Store' ? 'Inactive' :
            device.Asset_State === 'Maintenance' ? 'Maintenance' : 'Active',
      };
    });

    // Calculate statistics from all devices (without search filter)
    const totalDevices = allDevicesWithPM.length;
    const activeDevices = allDevicesWithPM.filter(d => d.status === 'Active').length;
    const today = new Date();
    const thirtyDaysFromNow = new Date(today);
    thirtyDaysFromNow.setDate(today.getDate() + 30);
    const upcomingPM = allDevicesWithPM.filter(d => {
      if (!d.nextPM) return false;
      const nextPMDate = new Date(d.nextPM);
      return nextPMDate <= thirtyDaysFromNow;
    }).length;

    console.log(`[getDevicesWithPM] Returning ${devicesWithPM.length} devices with statistics:`, {
      totalDevices,
      activeDevices,
      upcomingPM
    });

    res.status(200).json({
      success: true,
      data: devicesWithPM,
      statistics: {
        totalDevices,
        activeDevices,
        upcomingPM
      }
    });
  } catch (error) {
    console.error('[getDevicesWithPM] Error:', error);
    console.error('[getDevicesWithPM] Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Error getting devices with PM',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

module.exports = {
  createDevice,              // POST
  getDevices,                // GET (all with pagination)
  getDevicesExcludeInStore,  // GET (exclude "In Store")
  getDevicesExcludeOutStore, // GET (exclude "Out Store")
  getDeviceById,             // GET (by id)
  getDashboard,              // GET (dashboard statistics)
  getDevicesByModel,         // GET (grouped by model)
  getVendors,                // GET (distinct Project_purchase สำหรับ dropdown)
  getReferSOFList,           // GET (unique Refer_SOF values)
  getAssignedServicesList,   // GET (unique Assigned_Service สำหรับ dropdown Service)
  getDevicesBySOFAndSite,    // GET (devices ตาม Refer_SOF และ site_id)
  getImportLocation2HintsByContractAndSof, // GET (distinct SLid+Location2 on contract for Refer_SOF — import hints)
  getDevicesByContractAndSite, // GET (devices จาก contract_device ตาม contract_id + slid)
  getDevicesBySerials,       // GET (devices ตาม serial หลายตัว ?serials=A,B,C)
  getDevicesBySiteNoSOF,     // GET (devices ตาม site_id ที่ยังไม่มี SOF)
  getDevicesNoSofInStore,    // GET (devices ที่ไม่มี SOF + สถานะ In Store สำหรับ Edit Contract SOF ใหม่)
  getDevicesBySite,          // GET (devices ตาม site_id สำหรับ Asset Binding)
  getDevicesByAssetState,    // GET (devices ตาม Asset_State สำหรับ MA)
  getReplacementDevices,    // GET In Store ทุก lid ของ site บางนา
  getDevicesWithPM,          // GET (devices with PM information for Asset & Site Database)
  viewDeviceHistory,         // GET (view all device history)
  getDeviceHistory,          // GET (device history by id)
  updateAssetState,          // PUT (update asset state - multiple)
  updateDevice,              // PUT
  deleteDevice               // DELETE
};

