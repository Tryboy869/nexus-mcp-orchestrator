// startup.js - Script de démarrage avec diagnostic automatique
import { BackendService } from './server.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log(`
╔════════════════════════════════════════════════════════════╗
║         NEXUS MCP ORCHESTRATOR - DÉMARRAGE                 ║
╚════════════════════════════════════════════════════════════╝
`);

// ============================================================================
// 1. VÉRIFICATION VARIABLES D'ENVIRONNEMENT
// ============================================================================

console.log('📋 Vérification des variables d\'environnement...\n');

const requiredVars = {
  'GITHUB_TOKEN': process.env.GITHUB_TOKEN,
  'GROQ_API_KEY_1': process.env.GROQ_API_KEY_1,
  'TURSO_DATABASE_URL': process.env.TURSO_DATABASE_URL,
  'TURSO_AUTH_TOKEN': process.env.TURSO_AUTH_TOKEN,
  'ADMIN_KEY': process.env.ADMIN_KEY || 'nexus-studio'
};

let allOk = true;

for (const [key, value] of Object.entries(requiredVars)) {
  if (value) {
    console.log(`✅ ${key}: Défini`);
    if (key === 'ADMIN_KEY') {
      console.log(`   → Valeur: "${value}"`);
    }
  } else {
    console.log(`❌ ${key}: MANQUANT!`);
    allOk = false;
  }
}

console.log('');

if (!allOk) {
  console.error('❌ Variables manquantes! Configure-les sur Render.');
  console.error('   Dashboard Render → Environment → Add Environment Variable\n');
  process.exit(1);
}

// ============================================================================
// 2. INITIALISATION BACKEND
// ============================================================================

console.log('🚀 Initialisation du backend...\n');

const backend = new BackendService();

try {
  await backend.init();
  console.log('✅ Backend initialisé avec succès!\n');
} catch (error) {
  console.error('❌ Erreur initialisation backend:', error.message);
  console.error('   Stack:', error.stack);
  process.exit(1);
}

// ============================================================================
// 3. SCAN INITIAL IMMÉDIAT
// ============================================================================

console.log('🔍 Lancement du scan initial...\n');

try {
  const result = await backend.scanAndAnalyze();
  
  if (result.success) {
    console.log(`✅ Scan réussi! ${result.processed} serveurs traités.\n`);
  } else {
    console.log(`⚠️  Scan terminé avec avertissement: ${result.error}\n`);
  }
  
  // Afficher stats
  const stats = await backend.getStats();
  console.log('📊 Stats actuelles:');
  console.log(`   - Serveurs MCP: ${stats.stats.totalServers}`);
  console.log(`   - Score moyen: ${stats.stats.averageScore}`);
  console.log(`   - Matches: ${stats.stats.totalMatches}\n`);
  
} catch (error) {
  console.error('❌ Erreur lors du scan:', error.message);
  console.error('   Le serveur va quand même démarrer...\n');
}

// ============================================================================
// 4. DÉMARRAGE SERVEUR EXPRESS
// ============================================================================

console.log('🌐 Démarrage du serveur web...\n');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Rate limiting simple
const rateLimits = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const requests = rateLimits.get(ip).filter(t => now - t < 900000);
  
  if (requests.length >= 100) {
    return res.status(429).json({ success: false, message: 'Rate limit' });
  }
  
  requests.push(now);
  rateLimits.set(ip, requests);
  next();
});

// Routes Frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/explore.html', (req, res) => res.sendFile(path.join(__dirname, 'explore.html')));
app.get('/server-detail.html', (req, res) => res.sendFile(path.join(__dirname, 'server-detail.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Routes API
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'healthy',
    adminKey: process.env.ADMIN_KEY || 'nexus-studio',
    timestamp: new Date().toISOString() 
  });
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
    const result = await backend.getServers({
      category: req.query.category,
      minScore: req.query.minScore
    });
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
    return res.status(403).json({ 
      success: false, 
      message: `Invalid admin key. Expected: "${process.env.ADMIN_KEY}"` 
    });
  }
  
  try {
    const result = await backend.scanAndAnalyze();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Error handlers
app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// Démarrer serveur
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║              SERVEUR DÉMARRÉ AVEC SUCCÈS! ✅               ║
╠════════════════════════════════════════════════════════════╣
║  URL:        http://0.0.0.0:${PORT}                        
║  Admin Key:  ${process.env.ADMIN_KEY || 'nexus-studio'}                         
║  Frontend:   *.html                                        ║
║  Database:   Turso (auto-init)                             ║
║  AI:         Groq Multi-Agent                              ║
╚════════════════════════════════════════════════════════════╝

📌 Pour accéder au dashboard admin:
   1. Va sur: /admin.html
   2. Entre l'admin key: ${process.env.ADMIN_KEY || 'nexus-studio'}
   3. Clique "Trigger Manual Scan" pour forcer un scan

🔍 Le scan automatique tourne maintenant toutes les heures.

`);
});

// ============================================================================
// 5. CRON: SCAN AUTOMATIQUE TOUTES LES HEURES
// ============================================================================

cron.schedule('0 * * * *', async () => {
  console.log('\n⏰ [CRON] Scan automatique programmé...');
  try {
    const result = await backend.scanAndAnalyze();
    console.log(`✅ [CRON] Scan terminé: ${result.processed} serveurs traités\n`);
  } catch (error) {
    console.error(`❌ [CRON] Erreur: ${error.message}\n`);
  }
});

console.log('⏰ Cron job configuré: Scan toutes les heures\n');