const db = require('../config/database');
const { normalizeRole } = require('../utils/roleUtils');
const { tenantEmployeeFilter } = require('../utils/tenantScope');
const { systemUsernameExcludeSql, getSystemUsernames } = require('../utils/systemAccounts');
const {
  ensureAuthLinkReady,
  createAndLinkLoginAccount,
  unlinkAndDeleteLoginIfAny,
} = require('../lib/employeeAuthLink');

const normalizePositionType = (rawType) => {
  const type = String(rawType || '').trim().toLowerCase();
  if (type === 'management') return 'Management';
  if (type === 'engineer') return 'Engineer';
  if (type === 'technical') return 'Technical';
  return 'Technical';
};

// Helper - ให้ไอดีล่าสุดที่ว่าง (เช่น คนที่ 1 ลาออก ไอดีสูงสุด 3 → คนใหม่ได้ 1)
const generateNextUserId = async () => {
  try {
    const sql = `SELECT user_id FROM user_profiles`;
    const [rows] = await db.execute(sql);

    if (rows.length === 0) return '1';

    const numericIds = [];
    for (const row of rows) {
      const val = row.user_id;
      const num = typeof val === 'number' ? val : parseInt(String(val).replace(/\D/g, '') || '0', 10);
      if (!isNaN(num) && num > 0) numericIds.push(num);
    }

    if (numericIds.length === 0) return '1';

    const maxId = Math.max(...numericIds);
    const idSet = new Set(numericIds);

    for (let i = 1; i <= maxId; i++) {
      if (!idSet.has(i)) {
        return String(i);
      }
    }
    return String(maxId + 1);
  } catch (error) {
    console.error('Error generating next user_id:', error);
    throw error;
  }
};

// GET - ดึงข้อมูล Employees ทั้งหมด (+ บัญชี Login ที่เชื่อม ถ้ามี)
const getEmployees = async (req, res) => {
  try {
    await ensureAuthLinkReady();
    // ดึง query parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 1000;
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    // สร้าง WHERE condition สำหรับ search
    const ef = tenantEmployeeFilter(req.user && req.user.tenant, 'p.gmail');
    const hideSystem = systemUsernameExcludeSql('u.Username');
    let searchCondition = '';
    let searchParams = [];

    if (search) {
      const searchPattern = `%${search}%`;
      searchCondition = `WHERE (
        p.user_id LIKE ? OR 
        p.name LIKE ? OR 
        p.gmail LIKE ? OR 
        p.phone LIKE ? OR
        u.Username LIKE ?
      )${ef.sql}${hideSystem.sql}`;
      searchParams = [
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        ...ef.params,
        ...hideSystem.params,
      ];
    } else {
      searchCondition = `WHERE 1=1${ef.sql}${hideSystem.sql}`;
      searchParams = [...ef.params, ...hideSystem.params];
    }

    // นับจำนวน records ทั้งหมด
    const countSql = `
      SELECT COUNT(*) as total
      FROM user_profiles p
      LEFT JOIN user u ON u.User_id = p.auth_user_id
      ${searchCondition}`;
    const [countResult] = await db.execute(countSql, searchParams);
    const totalRecords = countResult[0].total;

    // ดึงข้อมูลตาม pagination (ไม่ส่ง profile_id ออก เรียงตาม user_id เป็นตัวเลข)
    const sql = `SELECT 
      p.user_id,
      p.name,
      p.phone,
      p.gmail,
      p.type,
      p.employment,
      p.em_picture,
      p.auth_user_id,
      u.Username,
      u.Role
    FROM user_profiles p
    LEFT JOIN user u ON u.User_id = p.auth_user_id
    ${searchCondition}
    ORDER BY CAST(p.user_id AS UNSIGNED) ASC 
    LIMIT ? OFFSET ?`;

    const [rows] = await db.execute(sql, [...searchParams, limit, offset]);
    console.log(`Found ${rows.length} employees from database`);

    // Map data to match frontend format (รองรับทั้ง name, Name, Username จาก DB)
    const systemNames = new Set(getSystemUsernames());
    const employees = rows
      .map((row) => ({
      id: String(row.user_id),
      name: row.name ?? row.Name ?? row.Username ?? row.username ?? '',
      gmail: row.gmail || '',
      tel: row.phone || row.Phone || '',
      positionType: row.type || 'Technical',
      employmentType: row.employment || 'Full-Time',
      photo: row.em_picture || null,
      account: row.auth_user_id
        ? {
            id: Number(row.auth_user_id),
            Username: row.Username || '',
            Role: normalizeRole(row.Role),
          }
        : null,
    }))
      .filter((emp) => {
        const uname = String(emp.account?.Username || '')
          .trim()
          .toLowerCase();
        return !uname || !systemNames.has(uname);
      });

    console.log(`Mapped ${employees.length} employees for response`);

    res.status(200).json({
      success: true,
      data: employees,
      pagination: {
        page,
        limit,
        total: totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching employees:', error);
    const message = error && typeof error.message === 'string' ? error.message : 'Unknown error';
    res.status(500).json({
      success: false,
      message: 'Error getting employees',
      error: message,
    });
  }
};

// GET - ดึงข้อมูล Employee ตาม ID
const getEmployeeById = async (req, res) => {
  try {
    const { id } = req.params;

    const ef = tenantEmployeeFilter(req.user && req.user.tenant, 'p.gmail');
    const hideSystem = systemUsernameExcludeSql('u.Username');
    const sql = `SELECT 
      p.user_id,
      p.name,
      p.phone,
      p.gmail,
      p.type,
      p.employment,
      p.em_picture
    FROM user_profiles p
    LEFT JOIN user u ON u.User_id = p.auth_user_id
    WHERE p.user_id = ?${ef.sql}${hideSystem.sql}`;

    const [rows] = await db.execute(sql, [id, ...ef.params, ...hideSystem.params]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found',
      });
    }

    const row = rows[0];
    const employee = {
      id: String(row.user_id),
      name: row.name ?? row.Name ?? row.Username ?? row.username ?? '',
      gmail: row.gmail || '',
      tel: (row.phone ?? row.Phone) || '',
      positionType: row.type || 'Technical',
      employmentType: row.employment || 'Full-Time',
      photo: row.em_picture || null,
    };

    res.status(200).json({
      success: true,
      data: employee,
    });
  } catch (error) {
    console.error('Error fetching employee:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting employee',
      error: error.message,
    });
  }
};

// POST - อัปโหลดรูปพนักงาน (multer จะเก็บไฟล์แล้วส่ง path กลับ)
const uploadEmployeePhoto = (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'File not found' });
    }
    const photoPath = `/uploads/employees/${req.file.filename}`;
    res.status(200).json({ success: true, path: photoPath });
  } catch (error) {
    console.error('Error uploading employee photo:', error);
    res.status(500).json({
      success: false,
      message: 'Upload failed',
      error: error.message,
    });
  }
};

// POST - สร้าง Employee ใหม่ (+ บัญชี Login ในครั้งเดียว)
const createEmployee = async (req, res) => {
  try {
    await ensureAuthLinkReady();
    const {
      name,
      gmail,
      tel,
      positionType,
      employmentType,
      photo,
      Username,
      Password,
      Role,
      adminPassword,
    } = req.body;

    // ตรวจสอบข้อมูลที่จำเป็น
    if (!name || !gmail || !tel) {
      return res.status(400).json({
        success: false,
        message: 'Please provide complete data (name, Gmail or email, phone)',
      });
    }

    const username = String(Username ?? '').trim();
    const password = String(Password ?? '');
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and Password are required so the employee can log in',
      });
    }
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }

    // สร้าง user_id ใหม่โดยอัตโนมัติ (ใช้เลขที่ว่างก่อน)
    let newUserId = await generateNextUserId();

    // ตรวจสอบว่า user_id นี้มีอยู่แล้วหรือไม่ (ป้องกัน race condition)
    const checkSql = `SELECT user_id FROM user_profiles WHERE user_id = ?`;
    const [existing] = await db.execute(checkSql, [newUserId]);
    
    if (existing.length > 0) {
      // ถ้ามีแล้ว (อาจเกิดจาก race condition) ให้ลองหาใหม่
      newUserId = await generateNextUserId();
      const [retryExisting] = await db.execute(checkSql, [newUserId]);
      if (retryExisting.length > 0) {
        throw new Error('Cannot create user_id that does not exist, please try again');
      }
    }

    // แปลง employmentType ให้ตรงกับ enum ใน database
    let employment = employmentType || 'Full-Time';
    if (employment.toLowerCase().includes('full')) {
      employment = 'Full-Time';
    } else if (employment.toLowerCase().includes('contract')) {
      employment = 'Contract';
    } else if (employment.toLowerCase().includes('part')) {
      employment = 'Part-Time';
    }

    // แปลง positionType
    const type = normalizePositionType(positionType);

    // สร้าง employee ใหม่ (รวม em_picture ถ้ามี column ใน DB)
    const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/png?seed=${newUserId}`;
    const insertSql = `INSERT INTO user_profiles 
      (user_id, name, gmail, phone, type, employment, em_picture) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    
    await db.execute(insertSql, [
      newUserId,
      name,
      gmail,
      tel,
      type,
      employment,
      photo || defaultAvatar,
    ]);

    const linkResult = await createAndLinkLoginAccount({
      employeeId: newUserId,
      Username: username,
      Password: password,
      Role,
      adminPassword,
      actorUserId: req.user?.id,
      actorRole: req.user?.Role,
    });

    if (!linkResult.ok) {
      await db.execute('DELETE FROM user_profiles WHERE user_id = ?', [newUserId]);
      return res.status(linkResult.status).json({
        success: false,
        message: linkResult.message,
      });
    }

    // ดึงข้อมูล employee ที่สร้างใหม่
    const getSql = `SELECT 
      user_id,
      name,
      phone,
      gmail,
      type,
      employment,
      em_picture
    FROM user_profiles 
    WHERE user_id = ?`;

    const [newEmployee] = await db.execute(getSql, [newUserId]);

    const row = newEmployee[0];
    const employee = {
      id: String(row.user_id),
      name: row.name ?? row.Name ?? row.Username ?? row.username ?? '',
      gmail: row.gmail || '',
      tel: (row.phone ?? row.Phone) || '',
      positionType: row.type || 'Technical',
      employmentType: row.employment || 'Full-Time',
      photo: row.em_picture || null,
      account: linkResult.account,
    };

    res.status(201).json({
      success: true,
      message: 'Employee and login account created successfully',
      data: employee,
    });
  } catch (error) {
    console.error('Error creating employee:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating employee',
      error: error.message,
    });
  }
};

// POST - Import หลายคน — แต่ละแถวรับ name, gmail หรือ email, tel (ดู row.gmail ?? row.email)
const importEmployees = async (req, res) => {
  try {
    const list = req.body?.employees;
    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please send employees as an array',
      });
    }

    const results = { created: 0, failed: 0, errors: [] };

    for (let i = 0; i < list.length; i++) {
      const row = list[i] || {};
      const name = (row.name ?? row.Name ?? '').toString().trim();
      const gmail = (row.gmail ?? row.email ?? '').toString().trim();
      const tel = (row.tel ?? row.phone ?? row.Phone ?? '').toString().trim();

      if (!name || !gmail || !tel) {
        results.failed++;
        results.errors.push({
          row: i + 1,
          message: 'Name,Email, and phone must not be empty',
        });
        continue;
      }

      let employment = (row.employmentType ?? row.employment ?? 'Full-Time') || 'Full-Time';
      if (employment.toLowerCase().includes('full')) employment = 'Full-Time';
      else if (employment.toLowerCase().includes('contract')) employment = 'Contract';
      else if (employment.toLowerCase().includes('part')) employment = 'Part-Time';

      const type = normalizePositionType((row.positionType ?? row.type ?? 'Technical') || 'Technical');

      try {
        const newUserId = await generateNextUserId();
        const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/png?seed=${newUserId}`;
        const insertSql = `INSERT INTO user_profiles (user_id, name, gmail, phone, type, employment, em_picture) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await db.execute(insertSql, [newUserId, name, gmail, tel, type, employment, defaultAvatar]);
        results.created++;
      } catch (err) {
        results.failed++;
        let msg = err.message || 'Insert failed';
        if (err.code === 'ER_DUP_ENTRY' || (err.message && err.message.includes('Duplicate'))) {
          msg = `Email "${gmail}" already exists in the system`;
        }
        results.errors.push({ row: i + 1, message: msg });
      }
    }

    res.status(200).json({
      success: true,
      message: `Import completed: created ${results.created} employees, failed ${results.failed}`,
      data: results,
    });
  } catch (error) {
    console.error('Error importing employees:', error);
    res.status(500).json({
      success: false,
      message: 'Error importing employees',
      error: error.message,
    });
  }
};

// PUT - แก้ไข Employee ตาม ID
const updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, gmail, tel, positionType, employmentType, photo } = req.body;

    if (!name || !gmail || !tel) {
      return res.status(400).json({
        success: false,
        message: 'Please provide complete data (name, Gmail or email, phone)',
      });
    }

    let employment = employmentType || 'Full-Time';
    if (employment.toLowerCase && employment.toLowerCase().includes('full')) employment = 'Full-Time';
    else if (employment.toLowerCase && employment.toLowerCase().includes('contract')) employment = 'Contract';
    else if (employment.toLowerCase && employment.toLowerCase().includes('part')) employment = 'Part-Time';

    const type = normalizePositionType(positionType);

    // em_picture บาง DB ถูกตั้ง NOT NULL → เวลา "ลบรูป" ให้ fallback เป็น default avatar แทน NULL
    const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/png?seed=${id}`;
    const hasPhotoField = Object.prototype.hasOwnProperty.call(req.body || {}, 'photo');
    const nextPhoto =
      !hasPhotoField
        ? undefined // ไม่ได้ส่งมา = ไม่แก้รูปเดิม
        : typeof photo === 'string'
          ? (photo.trim() ? photo.trim() : defaultAvatar)
          : photo == null
            ? defaultAvatar
            : defaultAvatar;

    const setParts = ['name = ?', 'gmail = ?', 'phone = ?', 'type = ?', 'employment = ?'];
    const params = [name, gmail, tel, type, employment];
    if (nextPhoto !== undefined) {
      setParts.push('em_picture = ?');
      params.push(nextPhoto);
    }
    const updateSql = `UPDATE user_profiles SET ${setParts.join(', ')} WHERE user_id = ?`;
    params.push(id);
    const [result] = await db.execute(updateSql, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found',
      });
    }

    const getSql = `SELECT user_id, name, phone, gmail, type, employment, em_picture FROM user_profiles WHERE user_id = ?`;
    const [rows] = await db.execute(getSql, [id]);
    const row = rows[0];
    const employee = {
      id: String(row.user_id),
      name: row.name ?? row.Name ?? '',
      gmail: row.gmail || '',
      tel: (row.phone ?? row.Phone) || '',
      positionType: row.type || 'Technical',
      employmentType: row.employment || 'Full-Time',
      photo: row.em_picture || null,
    };

    res.status(200).json({
      success: true,
      message: 'Employee updated successfully',
      data: employee,
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating employee',
      error: error.message,
    });
  }
};

// DELETE - ลบ Employee ตาม ID (+ บัญชี Login ที่เชื่อม ถ้ามี และไม่ใช่ตัวเอง)
const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    try {
      await unlinkAndDeleteLoginIfAny(id, { protectUserId: req.user?.id });
    } catch (unlinkErr) {
      console.warn('Unlink/delete login for employee skipped:', unlinkErr.message);
    }

    const sql = `DELETE FROM user_profiles WHERE user_id = ?`;
    const [result] = await db.execute(sql, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Employee deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting employee',
      error: error.message,
    });
  }
};

module.exports = {
  getEmployees,
  getEmployeeById,
  createEmployee,
  importEmployees,
  uploadEmployeePhoto,
  updateEmployee,
  deleteEmployee,
};
