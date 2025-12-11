// api.js - NEXUS MCP Orchestrator - API Gateway + Security

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
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

// ============================================================================
// SECURITY & LOGGING SYSTEM
// ============================================================================

class SecurityLogger {
  constructor() {
    this.logs = [];
    this.maxLogsInMemory = 1000;
    this.rateLimits = new Map();
    this.blockedIPs = new Set();
    
    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs');
    }
  }
  
  log(level, type, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      type,
      ...data
    };
    
    this.logs.push(entry);
    if (this.logs.length > this.maxLogsInMemory) {
      this.logs.shift();
    }
    
    const emoji = {
      INFO: '[INFO]',
      WARN: '[WARN]',
      ERROR: '[ERROR]',
      SECURITY: '[SECURITY]'
    }[level] || '[LOG]';
    
    console.log(`${emoji} [${type}] ${JSON.stringify(data)}`);
    
    this.writeToFile(level, entry);
  }
  
  writeToFile(level, entry) {
    const date = new Date().toISOString().split('T')[0];
    const logLine = `[${entry.timestamp}] [${entry.level}] [${entry.type}] ${JSON.stringify(entry)}\n`;
    
    fs.appendFileSync(`logs/api-${date}.log`, logLine);
    
    if (level === 'SECURITY') {
      fs.appendFileSync(`logs/security-${date}.log`, logLine);
    }
    
    if (level === 'ERROR') {
      fs.appendFileSync(`logs/errors-${date}.log`, logLine);
    }
  }
  
  info(type, data) {
    this.log('INFO', type, data);
  }
  
  warn(type, data) {
    this.log('WARN', type, data);
  }
  
  error(type, data) {
    this.log('ERROR', type, data);
  }
  
  security(type, data) {
    this.log('SECURITY', type, data);
  }
  
  checkRateLimit(identifier, limit = 100, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    
    if (!this.rateLimits.has(identifier)) {
      this.rateLimits.set(identifier, []);
    }
    
    const requests = this.rateLimits.get(identifier);
    const validRequests = requests.filter(time => now - time < windowMs);
    
    if (validRequests.length >= limit) {
      this.security('RATE_LIMIT_EXCEEDED', {
        identifier,
        requests: validRequests.length,
        limit
      });
      return false;
    }
    
    validRequests.push(now);
    this.rateLimits.set(identifier, validRequests);
    
    if (validRequests.length >= limit * 0.8) {
      this.warn('RATE_LIMIT_WARNING', {
        identifier,
        requests: validRequests.length,
        limit
      });
    }
    
    return true;
  }
  
  detectSQLInjection(input) {
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/i,
      /(--|\#|\/\*|\*\/)/,
      /(\bOR\b.*=.*\bOR\b)/i,
      /('|"|;|\)|\()/
    ];
    
    for (const pattern of sqlPatterns) {
      if (pattern.test(input)) {
        return true;
      }
    }
    
    return false;
  }
  
  detectXSS(input) {
    const xssPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=\s*["'][^"']*["']/gi,
      /<iframe/gi
    ];
    
    for (const pattern of xssPatterns) {
      if (pattern.test(input)) {
        return true;
      }
    }
    
    return false;
  }
  
  validateRequest(req) {
    const ip = req.ip || req.connection.remoteAddress;
    
    if (this.blockedIPs.has(ip)) {
      this.security('BLOCKED_IP_ATTEMPT', { ip, endpoint: req.path });
      return { valid: false, reason: 'IP blocked' };
    }
    
    if (!this.checkRateLimit(ip, 100, 15 * 60 * 1000)) {
      return { valid: false, reason: 'Rate limit exceeded' };
    }
    
    if (req.body && JSON.stringify(req.body).length > 10 * 1024 * 1024) {
      this.warn('LARGE_PAYLOAD', { ip, size: JSON.stringify(req.body).length });
      return { valid: false, reason: 'Payload too large' };
    }
    
    const checkObject = (obj) => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          if (this.detectSQLInjection(value)) {
            this.security('SQL_INJECTION_ATTEMPT', { ip, field: key, value: value.substring(0, 100) });
            return false;
          }
          if (this.detectXSS(value)) {
            this.security('XSS_ATTEMPT', { ip, field: key, value: value.substring(0, 100) });
            return false;
          }
        } else if (typeof value === 'object' && value !== null) {
          if (!checkObject(value)) return false;
        }
      }
      return true;
    };
    
    if (req.body && !checkObject(req.body)) {
      return { valid: false, reason: 'Malicious content detected' };
    }
    
    return { valid: true };
  }
  
  blockIP(ip, reason, durationMs = 24 * 60 * 60 * 1000) {
    this.blockedIPs.add(ip);
    this.security('IP_BLOCKED', { ip, reason, duration: durationMs });
    
    setTimeout(() => {
      this.blockedIPs.delete(ip);
      this.info('IP_UNBLOCKED', { ip });
    }, durationMs);
  }
  
  getStats() {
    const last24h = Date.now() - 24 * 60 * 60 * 1000;
    const recentLogs = this.logs.filter(l => new Date(l.timestamp) > last24h);
    
    return {
      total: recentLogs.length,
      byLevel: {
        INFO: recentLogs.filter(l => l.level === 'INFO').length,
        WARN: recentLogs.filter(l => l.level === 'WARN').length,
        ERROR: recentLogs.filter(l => l.level === 'ERROR').length,
        SECURITY: recentLogs.filter(l => l.level === 'SECURITY').length
      },
      byType: recentLogs.reduce((acc, log) => {
        acc[log.type] = (acc[log.type] || 0) + 1;
        return acc;
      }, {}),
      blockedIPs: Array.from(this.blockedIPs),
      topIPs: [...this.rateLimits.entries()]
        .map(([ip, requests]) => ({ ip, requests: requests.length }))
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 10)
    };
  }
  
  getRecentLogs(limit = 100) {
    return this.logs.slice(-limit).reverse();
  }
}

const securityLogger = new SecurityLogger();

// ============================================================================
// SECURITY MIDDLEWARE
// ============================================================================

app.use((req, res, next) => {
  const startTime = Date.now();
  const ip = req.ip || req.connection.remoteAddress;
  const userId = req.headers['x-user-id'] || 'anonymous';
  
  const validation = securityLogger.validateRequest(req);
  
  if (!validation.valid) {
    securityLogger.security('REQUEST_BLOCKED', {
      ip,
      userId,
      method: req.method,
      endpoint: req.path,
      reason: validation.reason
    });
    
    return res.status(403).json({
      success: false,
      message: 'Request blocked for security reasons'
    });
  }
  
  securityLogger.info('API_REQUEST', {
    ip,
    userId,
    method: req.method,
    endpoint: req.path,
    userAgent: req.headers['user-agent']
  });
  
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    
    securityLogger.info('API_RESPONSE', {
      ip,
      userId,
      method: req.method,
      endpoint: req.path,
      statusCode: res.statusCode,
      duration
    });
    
    originalSend.call(this, data);
  };
  
  next();
});

// ============================================================================
// BACKEND INITIALIZATION
// ============================================================================

let backend;

async function initBackend() {
  securityLogger.info('SYSTEM', { message: 'Initializing backend service...' });
  try {
    backend = new BackendService();
    await backend.init();
    securityLogger.info('SYSTEM', { message: 'Backend service ready' });
  } catch (error) {
    securityLogger.error('SYSTEM', { message: 'Backend init failed', error: error.message });
    throw error;
  }
}

// ============================================================================
// CRON JOBS (Automated Scanning)
// ============================================================================

function startCronJobs() {
  // Scan every hour
  cron.schedule('0 * * * *', async () => {
    securityLogger.info('CRON', { message: 'Starting scheduled scan...' });
    try {
      await backend.scanAndAnalyze();
      securityLogger.info('CRON', { message: 'Scheduled scan completed' });
    } catch (error) {
      securityLogger.error('CRON', { message: 'Scheduled scan failed', error: error.message });
    }
  });

  securityLogger.info('CRON', { message: 'Cron jobs started (hourly scans)' });
}

// ============================================================================
// FRONTEND ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/explore.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'explore.html'));
});

app.get('/server-detail.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'server-detail.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.get('/api/health', async (req, res) => {
  try {
    const result = await backend.healthCheck();
    res.json(result);
  } catch (error) {
    securityLogger.error('API_ERROR', {
      endpoint: '/api/health',
      error: error.message
    });
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const result = await backend.getStats();
    res.json(result);
  } catch (error) {
    securityLogger.error('API_ERROR', {
      endpoint: '/api/stats',
      error: error.message
    });
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
    securityLogger.error('API_ERROR', {
      endpoint: '/api/servers',
      error: error.message
    });
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/servers/:id', async (req, res) => {
  try {
    const result = await backend.getServerById(req.params.id);
    res.json(result);
  } catch (error) {
    securityLogger.error('API_ERROR', {
      endpoint: '/api/servers/:id',
      error: error.message
    });
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const result = await backend.scanAndAnalyze();
    res.json(result);
  } catch (error) {
    securityLogger.error('API_ERROR', {
      endpoint: '/api/scan',
      error: error.message
    });
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

app.get('/api/admin/logs', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    securityLogger.security('UNAUTHORIZED_ADMIN_ACCESS', {
      ip: req.ip,
      endpoint: '/api/admin/logs'
    });
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  
  const logs = securityLogger.getRecentLogs(500);
  res.json({ success: true, logs });
});

app.get('/api/admin/stats', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    securityLogger.security('UNAUTHORIZED_ADMIN_ACCESS', {
      ip: req.ip,
      endpoint: '/api/admin/stats'
    });
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  
  const stats = securityLogger.getStats();
  res.json({ success: true, stats });
});

app.post('/api/admin/block-ip', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  
  const { ip, reason } = req.body;
  securityLogger.blockIP(ip, reason);
  res.json({ success: true, message: `IP ${ip} blocked` });
});

// ============================================================================
// ERROR HANDLERS
// ============================================================================

app.use((err, req, res, next) => {
  securityLogger.error('UNHANDLED_ERROR', {
    error: err.message,
    stack: err.stack,
    endpoint: req.path
  });
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.use((req, res) => {
  securityLogger.warn('404_NOT_FOUND', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ============================================================================
// START SERVER
// ============================================================================

async function startServer() {
  await initBackend();
  startCronJobs();
  
  app.listen(PORT, '0.0.0.0', () => {
    securityLogger.info('SYSTEM', {
      message: 'Server started',
      port: PORT,
      environment: process.env.NODE_ENV || 'development'
    });
    
    console.log(`
===============================================================
   NEXUS MCP ORCHESTRATOR - Secure API Gateway
   Server:     http://0.0.0.0:${PORT}
   Frontend:   *.html (multi-pages)
   Security:   Active (Rate Limit, Validation)
   Logging:    logs/* (security, api, errors)
   Cron:       Hourly scans (500 repos/scan)
   Backend:    Multi-Agent Groq Pool
   Database:   Turso (libSQL)
===============================================================
    `);
  });
}

process.on('SIGTERM', () => {
  securityLogger.info('SYSTEM', { message: 'SIGTERM received, shutting down gracefully' });
  process.exit(0);
});

process.on('SIGINT', () => {
  securityLogger.info('SYSTEM', { message: 'SIGINT received, shutting down gracefully' });
  process.exit(0);
});

startServer();