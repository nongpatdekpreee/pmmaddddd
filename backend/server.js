const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const loginRoutes = require('./routes/loginRoutes');
const { authenticateToken } = require('./middleware/authMiddleware');
const { requireSession } = require('./middleware/requireSession');

// โหลด config database เพื่อทดสอบการเชื่อมต่อตอน start server
require('./config/database');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use('/api/auth', loginRoutes);
// Serve uploaded files — ต้องมี session (refresh cookie)
app.use('/uploads', requireSession, express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Routes
const siteRoutes = require('./routes/siteRoutes');
app.use('/api/sites', authenticateToken, siteRoutes);

const manufacturerRoutes = require('./routes/manufacturerRoutes');
app.use('/api/manufacturers', authenticateToken, manufacturerRoutes);

const deviceRoleRoutes = require('./routes/deviceRoleRoutes');
app.use('/api/device-roles', authenticateToken, deviceRoleRoutes);

const deviceTypeRoutes = require('./routes/deviceTypeRoutes');
app.use('/api/device-types', authenticateToken, deviceTypeRoutes);

const deviceRoutes = require('./routes/deviceRoutes');
app.use('/api/devices', authenticateToken, deviceRoutes);

const employeeRoutes = require('./routes/employeeRoutes');
app.use('/api/employees', authenticateToken, employeeRoutes);

const contractRoutes = require('./routes/contractRoutes');
app.use('/api/contracts', authenticateToken, contractRoutes);

const taskRoutes = require('./routes/taskRoutes');
app.use('/api/tasks', authenticateToken, taskRoutes);

const reportRoutes = require('./routes/reportRoutes');
app.use('/api/pm-reports', authenticateToken, reportRoutes);
app.use('/api/ma-reports', authenticateToken, reportRoutes);

const analyticsRoutes = require('./routes/analyticsRoutes');
app.use('/api/analytics', authenticateToken, analyticsRoutes);

const holidayRoutes = require('./routes/holidayRoutes');
app.use('/api/holidays', authenticateToken, holidayRoutes);

const { isContractMergeEnabled } = require('./lib/featureFlags');
/** Feature flags from backend .env (runtime) — client should prefer this over NEXT_PUBLIC_* */
app.get('/api/features', authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: {
      contractMerge: isContractMergeEnabled(),
    },
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'MA/PM Plan API',
    version: '0.0.3'
  });
});

// 404 ใต้ /api ที่ไม่มี route — ตอบ JSON แทนข้อความ plain/HTML ของ Express
app.use((req, res) => {
  if (String(req.originalUrl || '').startsWith('/api')) {
    return res.status(404).json({
      success: false,
      message: 'API route not found',
      path: req.originalUrl,
    });
  }
  res.status(404).type('txt').send('Not found');
});

// Cron jobs (PM/MA plans @ Mon 09:00, contract expiring @ daily 09:00)
const { startCronJobs } = require('./cron/scheduler');
const { ensureRefreshTokensTable } = require('./scripts/runRefreshTokensMigration');
const { ensureUserTable } = require('./scripts/runUserTableMigration');
const { ensureEmployeeAuthLinkColumn } = require('./scripts/runEmployeeAuthLinkMigration');

function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || String(secret).trim() === '') {
    throw new Error('JWT_SECRET is required — set it in backend/.env or container environment');
  }
}

async function startServer() {
  requireJwtSecret();
  await ensureUserTable();
  await ensureRefreshTokensTable();
  await ensureEmployeeAuthLinkColumn();
  const { getSystemUsernames } = require('./utils/systemAccounts');
  const hidden = getSystemUsernames().length;
  if (hidden > 0) {
    console.log(`[auth] SYSTEM_USERNAMES loaded — hiding ${hidden} account(s) from Employee list`);
  }
  startCronJobs();
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
