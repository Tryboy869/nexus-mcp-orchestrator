// api.js - NEXUS AXION - Gateway Simple
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { BackendService } from './server.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Simple rate limiting
const rateLimits = new Map();
const checkRateLimit = (ip) => {
  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  
  const requests = rateLimits.get(ip).filter(time => now - time < 900000);
  
  if (requests.length >= 100) return false;
  
  requests.push(now);
  rateLimits.set(ip, requests);
  return true;
};

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ success: false, message: 'Rate limit exceeded' });
  }
  
  next();
});

// Backend
let backend;

async function initBackend() {
  console.log('[INIT] Starting backend...');
  backend = new BackendService();
  await backend.init();
  console.log('[INIT] Backend ready');
}

// Cron: Scan every hour
function startCron() {
  cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Starting hourly scan...');
    await backend.scanAndAnalyze();
  });
  console.log('[CRON] Hourly scans enabled');
}

// Frontend Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/explore.html', (req, res) => res.sendFile(path.join(__dirname, 'explore.html')));
app.get('/server-detail.html', (req, res) => res.sendFile(path.join(__dirname, 'server-detail.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// API Routes
app.get('/api/health', async (req, res) => {
  res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/stats', async (req, res) => {
  try {
    const result = await backend.getStats();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/servers', async (req, res) => {
  try {
    const filters = {
      category: req.query.category,
      minScore: req.query.minScore
    };
    const result = await backend.getServers(filters);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/servers/:id', async (req, res) => {
  try {
    const result = await backend.getServerById(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/scan', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  
  try {
    const result = await backend.scanAndAnalyze();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Error handlers
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// Start
async function start() {
  await initBackend();
  startCron();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
===============================================================
   NEXUS MCP ORCHESTRATOR
   URL:        http://0.0.0.0:${PORT}
   Frontend:   *.html
   Database:   Turso (auto-init)
   AI:         Groq Multi-Agent
   Cron:       Hourly scans
===============================================================
    `);
  });
}

start();