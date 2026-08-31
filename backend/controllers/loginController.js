const db = require('../config/database');
const argon2 = require('argon2');
const { signAccessToken } = require('../services/tokenService');
const {
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  findValidToken,
  setRefreshCookie,
  clearRefreshCookie,
  REFRESH_TOKEN_COOKIE_NAME,
} = require('../services/refreshTokenService');
const { normalizeRole, toDbRole } = require('../utils/roleUtils');
const { resolveTenantForUserId, tenantFromEmail } = require('../utils/tenantScope');
const { systemUsernameExcludeSql } = require('../utils/systemAccounts');
const {
  ensureAuthLinkReady,
  createAndLinkLoginAccount,
} = require('../lib/employeeAuthLink');
const { parseTelLineFromDb, PHONE_MAIN_MIN_DIGITS, PHONE_MAIN_MAX_DIGITS, PHONE_EXT_MAX_DIGITS } = require('../utils/phoneFormat');

async function generateNextProfileUserId() {
  const [rows] = await db.execute('SELECT user_id FROM user_profiles');
  if (rows.length === 0) return '1';
  const numericIds = [];
  for (const row of rows) {
    const num = typeof row.user_id === 'number' ? row.user_id : parseInt(String(row.user_id).replace(/\D/g, '') || '0', 10);
    if (!Number.isNaN(num) && num > 0) numericIds.push(num);
  }
  if (numericIds.length === 0) return '1';
  const maxId = Math.max(...numericIds);
  const idSet = new Set(numericIds);
  for (let i = 1; i <= maxId; i++) {
    if (!idSet.has(i)) return String(i);
  }
  return String(maxId + 1);
}

function validateRegisterPhone(telLine) {
  const parsed = parseTelLineFromDb(String(telLine || '').trim());
  const mainD = String(parsed.tel || '').replace(/\D/g, '');
  const extD = String(parsed.telExt || '').replace(/\D/g, '');
  if (!mainD) return 'Phone is required.';
  if (mainD.length < PHONE_MAIN_MIN_DIGITS) {
    return `Phone must be at least ${PHONE_MAIN_MIN_DIGITS} digits.`;
  }
  if (mainD.length > PHONE_MAIN_MAX_DIGITS) {
    return `Phone must be at most ${PHONE_MAIN_MAX_DIGITS} digits.`;
  }
  if (extD && (extD.length < 1 || extD.length > PHONE_EXT_MAX_DIGITS)) {
    return 'Extension must be 1–6 digits when provided.';
  }
  return '';
}

async function buildAuthSession(user) {
  const tenant = await resolveTenantForUserId(user.User_id);
  if (!tenant) {
    return { ok: false };
  }
  const role = normalizeRole(user.Role);
  const payload = {
    id: user.User_id,
    Username: user.Username,
    Role: role,
    tenant,
  };
  return {
    ok: true,
    payload,
    token: signAccessToken(payload),
  };
}

// POST - สร้าง user ใหม่
const createUser = async (req, res) => {
  try {
    const Username = String(req.body?.Username ?? '').trim();
    const Password = String(req.body?.Password ?? '');
    const gmail = String(req.body?.gmail ?? req.body?.email ?? '').trim().toLowerCase();
    const tel = String(req.body?.tel ?? req.body?.phone ?? '').trim();

    if (!Username || !Password) {
      return res.status(400).json({
        success: false,
        message: 'กรุณากรอก Username และ Password'
      });
    }
    if (Password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }
    if (!gmail) {
      return res.status(400).json({
        success: false,
        message: 'Email is required.',
      });
    }
    if (!tenantFromEmail(gmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address.',
      });
    }
    const phoneErr = validateRegisterPhone(tel);
    if (phoneErr) {
      return res.status(400).json({
        success: false,
        message: phoneErr,
      });
    }

    const [existing] = await db.execute(
      'SELECT Username FROM user WHERE Username = ?',
      [Username]
    );
    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Username นี้มีอยู่ในระบบแล้ว'
      });
    }

    const [dupMail] = await db.execute(
      'SELECT user_id FROM user_profiles WHERE LOWER(TRIM(gmail)) = ? LIMIT 1',
      [gmail]
    );
    if (dupMail.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists in the system',
      });
    }

    await ensureAuthLinkReady();
    const hashedPassword = await argon2.hash(Password);
    const [result] = await db.execute(
      'INSERT INTO user (Username, Password, Role) VALUES (?, ?, ?)',
      [Username, hashedPassword, toDbRole('user')]
    );
    const authUserId = result.insertId;

    try {
      let profileId = await generateNextProfileUserId();
      const [existingProfile] = await db.execute(
        'SELECT user_id FROM user_profiles WHERE user_id = ?',
        [profileId]
      );
      if (existingProfile.length > 0) {
        profileId = await generateNextProfileUserId();
      }
      const defaultAvatar = `https://api.dicebear.com/7.x/avataaars/png?seed=${profileId}`;
      await db.execute(
        `INSERT INTO user_profiles
          (user_id, name, gmail, phone, type, employment, em_picture, auth_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [profileId, Username, gmail, tel, 'Technical', 'Full-Time', defaultAvatar, authUserId]
      );
    } catch (profileErr) {
      await db.execute('DELETE FROM user WHERE User_id = ?', [authUserId]);
      if (profileErr.code === 'ER_DUP_ENTRY' || (profileErr.message && profileErr.message.includes('Duplicate'))) {
        return res.status(400).json({
          success: false,
          message: 'Email already exists in the system',
        });
      }
      throw profileErr;
    }

    res.status(201).json({
      success: true,
      message: 'สร้าง user สำเร็จ',
      data: {
        id: authUserId,
        Username,
        Role: 'USER'
      }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการสร้าง user',
      error: error.message
    });
  }
};

// POST - Login
const login = async (req, res) => {
  try {
    const { Username, Password } = req.body;

    // ตรวจสอบข้อมูลที่จำเป็น
    if (!Username || !Password) {
      return res.status(400).json({
        success: false,
        message: 'กรุณากรอก Username และ Password'
      });
    }

    // ค้นหา user
    const [users] = await db.execute(
      'SELECT * FROM user WHERE Username = ?',
      [Username]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Username หรือ Password ไม่ถูกต้อง'
      });
    }

    const user = users[0];

    // ตรวจสอบ Password ด้วย argon2 (hash ไม่ถูกรูปแบบ → ถือว่า login ไม่ผ่าน)
    let isValidPassword = false;
    try {
      isValidPassword = await argon2.verify(user.Password, Password);
    } catch (verifyErr) {
      console.error('Password verify failed for user:', user.Username, verifyErr);
    }

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Username หรือ Password ไม่ถูกต้อง'
      });
    }

    const session = await buildAuthSession(user);
    if (!session.ok) {
      return res.status(401).json({
        success: false,
        message: 'Username หรือ Password ไม่ถูกต้อง',
      });
    }
    const refreshToken = await createRefreshToken(user.User_id);
    setRefreshCookie(res, refreshToken);

    res.status(200).json({
      success: true,
      message: 'Login สำเร็จ',
      data: {
        ...session.payload,
        token: session.token,
      }
    });
  } catch (error) {
    console.error('Error logging in:', error);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการ Login',
      ...(isProd ? {} : { error: error.message }),
    });
  }
};

// GET - ดึงข้อมูลผู้ใช้ที่ Login อยู่ (อ่าน Role จาก DB ล่าสุด)
const getMe = async (req, res) => {
  try {
    const [users] = await db.execute(
      'SELECT User_id, Username, Role FROM user WHERE User_id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบผู้ใช้',
      });
    }

    const user = users[0];
    const session = await buildAuthSession(user);
    if (!session.ok) {
      return res.status(403).json({
        success: false,
        message: 'บัญชีนี้ยังไม่ได้ผูกอีเมลบริษัท',
      });
    }
    res.status(200).json({
      success: true,
      data: session.payload,
    });
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้',
      error: error.message,
    });
  }
};

// GET - ตรวจ session จาก refresh cookie (ไม่หมุน token) — สำหรับ middleware
const checkSession = async (req, res) => {
  try {
    const raw = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    if (!raw) {
      return res.status(401).json({
        success: false,
        message: 'ไม่พบ session',
      });
    }

    const row = await findValidToken(raw);
    if (!row) {
      return res.status(401).json({
        success: false,
        message: 'session หมดอายุ',
      });
    }

    const [users] = await db.execute(
      'SELECT User_id, Username, Role FROM user WHERE User_id = ?',
      [row.user_id]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'ไม่พบผู้ใช้',
      });
    }

    const user = users[0];
    const session = await buildAuthSession(user);
    if (!session.ok) {
      return res.status(403).json({
        success: false,
        message: 'บัญชีนี้ยังไม่ได้ผูกอีเมลบริษัท',
      });
    }
    res.status(200).json({
      success: true,
      data: session.payload,
    });
  } catch (error) {
    console.error('Error checking session:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการตรวจสอบ session',
      error: error.message,
    });
  }
};

// POST - ต่ออายุ access token ด้วย refresh cookie (rotation)
const refresh = async (req, res) => {
  try {
    const raw = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    if (!raw) {
      return res.status(401).json({
        success: false,
        message: 'ไม่พบ refresh token กรุณา Login ใหม่',
      });
    }

    const rotated = await rotateRefreshToken(raw);
    if (!rotated) {
      clearRefreshCookie(res);
      return res.status(401).json({
        success: false,
        message: 'refresh token ไม่ถูกต้องหรือหมดอายุ กรุณา Login ใหม่',
      });
    }

    const [users] = await db.execute(
      'SELECT User_id, Username, Role FROM user WHERE User_id = ?',
      [rotated.userId]
    );

    if (users.length === 0) {
      clearRefreshCookie(res);
      return res.status(401).json({
        success: false,
        message: 'ไม่พบผู้ใช้ กรุณา Login ใหม่',
      });
    }

    const user = users[0];
    const session = await buildAuthSession(user);
    if (!session.ok) {
      clearRefreshCookie(res);
      return res.status(403).json({
        success: false,
        message: 'บัญชีนี้ยังไม่ได้ผูกอีเมลบริษัท',
      });
    }
    setRefreshCookie(res, rotated.refreshToken);

    res.status(200).json({
      success: true,
      message: 'ต่ออายุ token สำเร็จ',
      data: {
        ...session.payload,
        token: session.token,
      },
    });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการต่ออายุ token',
      error: error.message,
    });
  }
};

// POST - Logout (revoke refresh token + clear cookie)
const logout = async (req, res) => {
  try {
    const raw = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    if (raw) {
      await revokeRefreshToken(raw);
    }
    clearRefreshCookie(res);
    res.status(200).json({
      success: true,
      message: 'Logout สำเร็จ',
    });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการ Logout',
      error: error.message,
    });
  }
};

// GET - ดึง user ทั้งหมด
const getAllUsers = async (req, res) => {
  try {
    const [users] = await db.execute(
      'SELECT User_id , Username, Role FROM user ORDER BY User_id  ASC'
    );

    res.status(200).json({
      success: true,
      count: users.length,
      data: users.map((u) => ({
        id: u.User_id,
        Username: u.Username,
        Role: normalizeRole(u.Role),
      })),
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูล user',
      error: error.message
    });
  }
};

/** GET - พนักงาน + บัญชี Login ที่เชื่อม (ADMIN) */
const getEmployeeAccounts = async (req, res) => {
  try {
    await ensureAuthLinkReady();
    const hideSystem = systemUsernameExcludeSql('u.Username');
    const [rows] = await db.execute(
      `SELECT
         p.user_id AS employee_id,
         p.name,
         p.gmail,
         p.phone,
         p.type,
         p.employment,
         p.em_picture,
         p.auth_user_id,
         u.Username,
         u.Role
       FROM user_profiles p
       LEFT JOIN user u ON u.User_id = p.auth_user_id
       WHERE 1=1${hideSystem.sql}
       ORDER BY CAST(p.user_id AS UNSIGNED) ASC`,
      hideSystem.params
    );

    const data = rows.map((row) => ({
      employeeId: String(row.employee_id),
      name: row.name ?? '',
      gmail: row.gmail || '',
      tel: row.phone || '',
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
    }));

    res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error('Error fetching employee accounts:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลพนักงานและบัญชี',
      error: error.message,
    });
  }
};

/**
 * POST - สร้างบัญชี Login ให้พนักงาน + เชื่อม auth_user_id
 * body: { employeeId, Username, Password, Role?, adminPassword? }
 */
const createEmployeeAccount = async (req, res) => {
  try {
    const { employeeId, Username, Password, Role, adminPassword } = req.body || {};
    const result = await createAndLinkLoginAccount({
      employeeId,
      Username,
      Password,
      Role,
      adminPassword,
      actorUserId: req.user.id,
      actorRole: req.user.Role,
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    res.status(201).json({
      success: true,
      message: 'สร้างบัญชีและเชื่อมกับพนักงานสำเร็จ',
      data: {
        employeeId: String(employeeId),
        account: result.account,
      },
    });
  } catch (error) {
    console.error('Error creating employee account:', error);
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({
        success: false,
        message: 'บัญชีนี้ถูกเชื่อมกับพนักงานคนอื่นแล้ว',
      });
    }
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการสร้างบัญชีพนักงาน',
      error: error.message,
    });
  }
};

/**
 * PUT - เชื่อมพนักงานกับบัญชี Login ที่มีอยู่
 * body: { authUserId } หรือ { Username }
 */
const linkEmployeeAccount = async (req, res) => {
  try {
    await ensureAuthLinkReady();
    const empId = String(req.params.employeeId ?? '').trim();
    const { authUserId, Username } = req.body || {};

    if (!empId) {
      return res.status(400).json({ success: false, message: 'ไม่พบรหัสพนักงาน' });
    }

    const [emps] = await db.execute(
      'SELECT user_id, auth_user_id FROM user_profiles WHERE user_id = ?',
      [empId]
    );
    if (emps.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบพนักงาน' });
    }
    if (emps[0].auth_user_id) {
      return res.status(400).json({
        success: false,
        message: 'พนักงานคนนี้มีบัญชี Login แล้ว',
      });
    }

    let targetId = authUserId != null ? Number(authUserId) : NaN;
    if (!Number.isFinite(targetId) && Username) {
      const [users] = await db.execute(
        'SELECT User_id FROM user WHERE Username = ? LIMIT 1',
        [String(Username).trim()]
      );
      if (users.length === 0) {
        return res.status(404).json({ success: false, message: 'ไม่พบบัญชี Username นี้' });
      }
      targetId = Number(users[0].User_id);
    }
    if (!Number.isFinite(targetId)) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุ authUserId หรือ Username',
      });
    }

    const [users] = await db.execute(
      'SELECT User_id, Username, Role FROM user WHERE User_id = ?',
      [targetId]
    );
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบบัญชี Login' });
    }

    const [taken] = await db.execute(
      'SELECT user_id FROM user_profiles WHERE auth_user_id = ? LIMIT 1',
      [targetId]
    );
    if (taken.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'บัญชีนี้ถูกเชื่อมกับพนักงานคนอื่นแล้ว',
      });
    }

    await db.execute('UPDATE user_profiles SET auth_user_id = ? WHERE user_id = ?', [
      targetId,
      empId,
    ]);

    res.status(200).json({
      success: true,
      message: 'เชื่อมบัญชีสำเร็จ',
      data: {
        employeeId: empId,
        account: {
          id: Number(users[0].User_id),
          Username: users[0].Username,
          Role: normalizeRole(users[0].Role),
        },
      },
    });
  } catch (error) {
    console.error('Error linking employee account:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการเชื่อมบัญชี',
      error: error.message,
    });
  }
};

// PUT - อัปเดต Username หรือ Password
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { Username, Password, Role, adminPassword } = req.body;

    // ตรวจสอบว่ามี user อยู่หรือไม่
    const [existing] = await db.execute(
      'SELECT * FROM user WHERE User_id  = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบ user ที่ต้องการแก้ไข'
      });
    }

    // ต้องมีอย่างน้อย 1 ฟิลด์ที่จะอัปเดต
    if (!Username && !Password && Role === undefined) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุ Username, Password หรือ Role ที่ต้องการเปลี่ยน'
      });
    }

    // เปลี่ยนรหัสผ่านได้เฉพาะบัญชีตัวเอง
    if (Password && Number(id) !== Number(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: 'ไม่สามารถเปลี่ยนรหัสผ่านของผู้อื่นได้',
      });
    }

    // ห้าม ADMIN ลดสิทธิ์ตัวเอง
    if (
      Role !== undefined &&
      Number(id) === Number(req.user.id) &&
      normalizeRole(Role) !== 'ADMIN'
    ) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลดสิทธิ์บัญชีของตัวเองได้',
      });
    }

    // เปลี่ยน Role ต้องยืนยันรหัสผ่านของ admin ที่กำลังทำรายการ
    if (Role !== undefined) {
      const nextRole = normalizeRole(Role);
      const curRole = normalizeRole(existing[0].Role);
      if (nextRole !== curRole) {
        if (!adminPassword || String(adminPassword).trim() === '') {
          return res.status(400).json({
            success: false,
            message: 'กรุณายืนยันรหัสผ่านของคุณก่อนเปลี่ยน Role',
          });
        }
        const [actorRows] = await db.execute(
          'SELECT Password FROM user WHERE User_id = ?',
          [req.user.id]
        );
        if (actorRows.length === 0) {
          return res.status(401).json({
            success: false,
            message: 'ไม่พบบัญชีผู้ดำเนินการ',
          });
        }
        const passwordOk = await argon2.verify(actorRows[0].Password, adminPassword);
        if (!passwordOk) {
          return res.status(403).json({
            success: false,
            message: 'รหัสผ่านยืนยันไม่ถูกต้อง',
          });
        }
      }
    }

    // ถ้าเปลี่ยน Username ต้องตรวจสอบว่าไม่ซ้ำ
    if (Username) {
      const [duplicate] = await db.execute(
        'SELECT User_id  FROM user WHERE Username = ? AND User_id  != ?',
        [Username, id]
      );

      if (duplicate.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Username นี้มีอยู่ในระบบแล้ว'
        });
      }
    }

    // สร้าง query แบบ dynamic
    const updates = [];
    const values = [];

    if (Username) {
      updates.push('Username = ?');
      values.push(Username);
    }

    if (Password) {
      const hashedPassword = await argon2.hash(Password);
      updates.push('Password = ?');
      values.push(hashedPassword);
    }

    if (Role !== undefined) {
      updates.push('Role = ?');
      values.push(toDbRole(Role));
    }

    values.push(id);

    await db.execute(
      `UPDATE user SET ${updates.join(', ')} WHERE User_id  = ?`,
      values
    );

    res.status(200).json({
      success: true,
      message: 'อัปเดต user สำเร็จ',
      data: {
        id: parseInt(id),
        Username: Username || existing[0].Username,
        Role: Role !== undefined ? normalizeRole(Role) : normalizeRole(existing[0].Role),
      }
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการอัปเดต user',
      error: error.message
    });
  }
};

// DELETE - ลบ user
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    // ตรวจสอบว่ามี user อยู่หรือไม่
    const [existing] = await db.execute(
      'SELECT User_id , Username FROM user WHERE User_id  = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบ user ที่ต้องการลบ'
      });
    }

    if (Number(id) === Number(req.user.id)) {
      return res.status(400).json({
        success: false,
        message: 'ไม่สามารถลบบัญชีของตัวเองได้',
      });
    }

    try {
      await ensureAuthLinkReady();
      await db.execute(
        'UPDATE user_profiles SET auth_user_id = NULL WHERE auth_user_id = ?',
        [id]
      );
    } catch (unlinkErr) {
      console.warn('Unlink employee auth_user_id skipped:', unlinkErr.message);
    }

    await db.execute('DELETE FROM user WHERE User_id  = ?', [id]);

    res.status(200).json({
      success: true,
      message: 'ลบ user สำเร็จ',
      data: {
        id: existing[0].User_id ,
        Username: existing[0].Username
      }
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดในการลบ user',
      error: error.message
    });
  }
};

module.exports = {
  createUser,
  login,
  getMe,
  checkSession,
  refresh,
  logout,
  getAllUsers,
  getEmployeeAccounts,
  createEmployeeAccount,
  linkEmployeeAccount,
  updateUser,
  deleteUser
};

