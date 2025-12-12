// server.js - NEXUS MCP Orchestrator - Backend Logic
import { createClient } from '@libsql/client';
import Groq from 'groq-sdk';
import { Octokit } from '@octokit/rest';
import sgMail from '@sendgrid/mail';
import crypto from 'crypto';

// ============================================================================
// DATABASE SERVICE WITH AUTO-INIT
// ============================================================================

class DatabaseService {
  constructor() {
    this.client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });
  }

  async init() {
    console.log('[DB] Initializing database schema...');
    
    try {
      // Table: mcp_servers
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          repo_owner TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          repo_url TEXT NOT NULL,
          stars INTEGER DEFAULT 0,
          forks INTEGER DEFAULT 0,
          last_updated TEXT,
          score REAL DEFAULT 0,
          code_quality REAL DEFAULT 0,
          security REAL DEFAULT 0,
          documentation REAL DEFAULT 0,
          mcp_compliance REAL DEFAULT 0,
          maintenance INTEGER DEFAULT 0,
          category TEXT,
          features TEXT,
          recommendations TEXT,
          analyzed_at TEXT,
          notified_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(repo_owner, repo_name)
        )
      `);

      // Table: matches
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          user_repo_owner TEXT NOT NULL,
          user_repo_name TEXT NOT NULL,
          user_issue_url TEXT,
          relevance REAL NOT NULL,
          reason TEXT,
          features TEXT,
          status TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          notified_at TEXT
        )
      `);

      // Table: notifications
      await this.client.execute(`
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          target_repo_owner TEXT NOT NULL,
          target_repo_name TEXT NOT NULL,
          issue_url TEXT,
          server_id TEXT,
          sent_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      console.log('[DB] Schema initialized successfully');
    } catch (error) {
      console.error('[DB] Init error:', error.message);
      throw error;
    }
  }

  async execute(query) {
    return await this.client.execute(query);
  }

  async query(sql, args = []) {
    return await this.client.execute({ sql, args });
  }
}

// ============================================================================
// MULTI-AGENT GROQ POOL
// ============================================================================

class AgentPool {
  constructor() {
    this.agents = [];
    this.currentIndex = 0;
    this.initializeAgents();
  }

  initializeAgents() {
    const keys = [
      process.env.GROQ_API_KEY_1,
      process.env.GROQ_API_KEY_2,
      process.env.GROQ_API_KEY_3,
      process.env.GROQ_API_KEY_4
    ].filter(key => key && key.length > 0);

    if (keys.length === 0) {
      throw new Error('At least one GROQ_API_KEY must be configured');
    }

    keys.forEach((key, index) => {
      this.agents.push({
        id: `agent-${index + 1}`,
        client: new Groq({ apiKey: key }),
        model: 'llama-3.1-70b-versatile',
        usage: { requests: 0, limit: 30, resetAt: Date.now() + 60000 },
        status: 'active'
      });
    });

    console.log(`[AGENTS] Initialized ${this.agents.length} agent(s)`);
    
    // Reset usage every minute
    setInterval(() => {
      this.agents.forEach(agent => {
        agent.usage.requests = 0;
        agent.status = 'active';
      });
    }, 60000);
  }

  getNextAgent() {
    const now = Date.now();
    
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.agents.length;

      if (agent.usage.requests >= agent.usage.limit) continue;
      if (agent.usage.resetAt <= now) {
        agent.usage.requests = 0;
        agent.usage.resetAt = now + 60000;
      }

      return agent;
    }

    throw new Error('All agents rate limited. Please wait.');
  }

  async execute(prompt) {
    const agent = this.getNextAgent();

    try {
      const response = await agent.client.chat.completions.create({
        model: agent.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      });

      agent.usage.requests++;
      return response.choices[0].message.content;
    } catch (error) {
      if (error.message.includes('rate limit')) {
        agent.status = 'rate_limited';
        return this.execute(prompt); // Retry with next agent
      }
      throw error;
    }
  }
}

// ============================================================================
// GITHUB SCANNER
// ============================================================================

class GitHubScanner {
  constructor(db) {
    this.octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    this.db = db;
  }

  async scanNewServers(limit = 100) {
    console.log('[SCANNER] Starting GitHub scan...');
    console.log('[SCANNER] Query: topic:mcp-server OR topic:model-context-protocol');
    
    try {
      const result = await this.octokit.search.repos({
        q: 'topic:mcp-server OR topic:model-context-protocol',
        sort: 'updated',
        order: 'desc',
        per_page: limit
      });

      console.log(`[SCANNER] GitHub returned ${result.data.items.length} repos`);

      const newServers = [];

      for (const repo of result.data.items) {
        const exists = await this.checkIfExists(repo.full_name);
        
        if (!exists) {
          console.log(`[SCANNER] New server found: ${repo.full_name}`);
          newServers.push({
            id: crypto.randomUUID(),
            repo_owner: repo.owner.login,
            repo_name: repo.name,
            repo_url: repo.html_url,
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            last_updated: repo.updated_at
          });
        } else {
          console.log(`[SCANNER] Skipping existing: ${repo.full_name}`);
        }
      }

      console.log(`[SCANNER] Total new servers: ${newServers.length}`);
      return newServers;
    } catch (error) {
      console.error('[SCANNER] GitHub API Error:', error.message);
      if (error.status === 401) {
        console.error('[SCANNER] ❌ GITHUB_TOKEN is INVALID or EXPIRED!');
      }
      throw error;
    }
  }

  async checkIfExists(fullName) {
    const [owner, name] = fullName.split('/');
    const result = await this.db.query(
      'SELECT id FROM mcp_servers WHERE repo_owner = ? AND repo_name = ?',
      [owner, name]
    );
    return result.rows.length > 0;
  }

  async getReadme(owner, repo) {
    try {
      const { data } = await this.octokit.repos.getReadme({ owner, repo });
      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (error) {
      return '';
    }
  }

  detectLanguage(readme) {
    const lower = readme.toLowerCase();
    if (lower.includes('bonjour') || lower.includes('français')) return 'fr';
    if (lower.includes('hola') || lower.includes('español')) return 'es';
    return 'en';
  }
}

// ============================================================================
// AI ANALYZER
// ============================================================================

class AIAnalyzer {
  constructor(agentPool) {
    this.agentPool = agentPool;
  }

  async analyzeServer(server, readme) {
    const prompt = `Analyze this MCP server and return ONLY valid JSON.

Repository: ${server.repo_owner}/${server.repo_name}
Stars: ${server.stars}
README: ${readme.substring(0, 2000)}

Return JSON with this exact structure:
{
  "score": 8.5,
  "code_quality": 9.0,
  "security": 8.0,
  "documentation": 8.5,
  "mcp_compliance": 9.0,
  "maintenance": true,
  "category": "data",
  "features": ["feature1", "feature2"],
  "recommendations": ["rec1", "rec2"]
}

Categories: compute, data, api, tools, utility
Scores: 0-10`;

    try {
      const response = await this.agentPool.execute(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.error('[ANALYZER] Error:', error.message);
    }

    return {
      score: 5.0,
      code_quality: 5.0,
      security: 5.0,
      documentation: 5.0,
      mcp_compliance: 5.0,
      maintenance: false,
      category: 'utility',
      features: [],
      recommendations: []
    };
  }
}

// ============================================================================
// MATCHER
// ============================================================================

class MCPMatcher {
  constructor(db, agentPool, scanner) {
    this.db = db;
    this.agentPool = agentPool;
    this.scanner = scanner;
  }

  async findMatches(server, analysis) {
    try {
      const features = analysis.features.join(' OR ');
      const result = await this.scanner.octokit.search.issuesAndPullRequests({
        q: `"looking for" OR "need" ${features} MCP in:issue is:open`,
        per_page: 10
      });

      const matches = [];

      for (const issue of result.data.items) {
        const relevance = await this.calculateRelevance(server, analysis, issue);

        if (relevance.score >= 0.7) {
          matches.push({
            id: crypto.randomUUID(),
            server_id: server.id,
            user_repo_owner: issue.repository_url.split('/')[4],
            user_repo_name: issue.repository_url.split('/')[5],
            user_issue_url: issue.html_url,
            relevance: relevance.score,
            reason: relevance.reason,
            features: JSON.stringify(analysis.features),
            status: 'pending',
            created_at: new Date().toISOString()
          });
        }
      }

      return matches;
    } catch (error) {
      console.error('[MATCHER] Error:', error.message);
      return [];
    }
  }

  async calculateRelevance(server, analysis, issue) {
    const prompt = `Does this MCP server match the user's need? Return ONLY JSON.

Server: ${server.repo_name}
Features: ${analysis.features.join(', ')}
User Issue: ${issue.title}

Return JSON:
{
  "score": 0.85,
  "reason": "Brief explanation"
}`;

    try {
      const response = await this.agentPool.execute(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('[MATCHER] Relevance error:', error.message);
    }

    return { score: 0.0, reason: 'Unable to calculate' };
  }
}

// ============================================================================
// NOTIFIER
// ============================================================================

class NotificationManager {
  constructor(db, scanner) {
    this.db = db;
    this.scanner = scanner;
    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    }
  }

  async notifyMaintainer(server, analysis, matches, language = 'en') {
    try {
      const canNotify = await this.checkCooldown(server.repo_owner, server.repo_name);
      if (!canNotify) return { success: false, reason: 'cooldown' };

      const template = this.getTemplate(server, analysis, matches, language);

      const issue = await this.scanner.octokit.issues.create({
        owner: server.repo_owner,
        repo: server.repo_name,
        title: template.title,
        body: template.body,
        labels: ['nexus-mcp-orchestrator']
      });

      await this.db.query(
        `INSERT INTO notifications (id, type, target_repo_owner, target_repo_name, issue_url, server_id, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), 'maintainer', server.repo_owner, server.repo_name, issue.data.html_url, server.id, new Date().toISOString()]
      );

      console.log(`[NOTIFIER] Notified: ${issue.data.html_url}`);
      return { success: true, url: issue.data.html_url };
    } catch (error) {
      console.error('[NOTIFIER] Error:', error.message);
      return { success: false, reason: error.message };
    }
  }

  async checkCooldown(owner, repo) {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const result = await this.db.query(
      'SELECT id FROM notifications WHERE target_repo_owner = ? AND target_repo_name = ? AND sent_at > ?',
      [owner, repo, oneHourAgo]
    );
    return result.rows.length === 0;
  }

  getTemplate(server, analysis, matches, language) {
    const email = process.env.NEXUS_STUDIO_EMAIL || 'nexusstudio100@gmail.com';
    const ceo = process.env.NEXUS_STUDIO_CEO || 'Daouda Abdoul Anzize';

    if (language === 'fr') {
      return {
        title: `Votre Serveur MCP Correspond à ${matches.length} Utilisateurs`,
        body: `## Bonjour de Nexus Studio !

Je suis NEXUS MCP Orchestrator, une IA développée par Nexus Studio.

**CEO**: ${ceo}
**Contact**: ${email}

---

### Votre Serveur MCP

**Score**: ${analysis.score}/10
**Catégorie**: ${analysis.category}
**Matches trouvés**: ${matches.length}

### Features Détectées

${analysis.features.map(f => `- ${f}`).join('\n')}

---

_Nexus Studio - ${ceo} - ${email}_`
      };
    }

    return {
      title: `Your MCP Server Matched with ${matches.length} Users`,
      body: `## Hello from Nexus Studio!

I'm NEXUS MCP Orchestrator, an AI by Nexus Studio.

**CEO**: ${ceo}
**Contact**: ${email}

---

### Your MCP Server

**Score**: ${analysis.score}/10
**Category**: ${analysis.category}
**Matches found**: ${matches.length}

### Detected Features

${analysis.features.map(f => `- ${f}`).join('\n')}

---

_Nexus Studio - ${ceo} - ${email}_`
    };
  }
}

// ============================================================================
// BACKEND SERVICE
// ============================================================================

export class BackendService {
  constructor() {
    this.db = null;
    this.agentPool = null;
    this.scanner = null;
    this.analyzer = null;
    this.matcher = null;
    this.notifier = null;
  }

  async init() {
    console.log('[BACKEND] Initializing...');
    
    this.db = new DatabaseService();
    await this.db.init();
    
    this.agentPool = new AgentPool();
    this.scanner = new GitHubScanner(this.db);
    this.analyzer = new AIAnalyzer(this.agentPool);
    this.matcher = new MCPMatcher(this.db, this.agentPool, this.scanner);
    this.notifier = new NotificationManager(this.db, this.scanner);

    console.log('[BACKEND] Ready');
  }

  async scanAndAnalyze() {
    console.log('[SCAN] Starting...');

    try {
      const newServers = await this.scanner.scanNewServers(100);
      console.log(`[SCAN] Found ${newServers.length} new servers`);

      for (const server of newServers) {
        const readme = await this.scanner.getReadme(server.repo_owner, server.repo_name);
        const analysis = await this.analyzer.analyzeServer(server, readme);

        await this.db.query(
          `INSERT INTO mcp_servers 
           (id, repo_owner, repo_name, repo_url, stars, forks, last_updated,
            score, code_quality, security, documentation, mcp_compliance, 
            maintenance, category, features, recommendations, analyzed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            server.id, server.repo_owner, server.repo_name, server.repo_url,
            server.stars, server.forks, server.last_updated,
            analysis.score, analysis.code_quality, analysis.security,
            analysis.documentation, analysis.mcp_compliance,
            analysis.maintenance ? 1 : 0, analysis.category,
            JSON.stringify(analysis.features), JSON.stringify(analysis.recommendations),
            new Date().toISOString()
          ]
        );

        const matches = await this.matcher.findMatches(server, analysis);

        for (const match of matches) {
          await this.db.query(
            `INSERT INTO matches (id, server_id, user_repo_owner, user_repo_name, user_issue_url, relevance, reason, features, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [match.id, match.server_id, match.user_repo_owner, match.user_repo_name, match.user_issue_url, match.relevance, match.reason, match.features, match.status, match.created_at]
          );
        }

        if (matches.length > 0 && analysis.score >= 7.0) {
          const lang = this.scanner.detectLanguage(readme);
          await this.notifier.notifyMaintainer(server, analysis, matches, lang);
        }
      }

      return { success: true, processed: newServers.length };
    } catch (error) {
      console.error('[SCAN] Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  async getStats() {
    const total = await this.db.query('SELECT COUNT(*) as count FROM mcp_servers');
    const avgScore = await this.db.query('SELECT AVG(score) as avg FROM mcp_servers');
    const totalMatches = await this.db.query('SELECT COUNT(*) as count FROM matches');

    return {
      success: true,
      stats: {
        totalServers: total.rows[0].count,
        averageScore: parseFloat(avgScore.rows[0].avg || 0).toFixed(2),
        totalMatches: totalMatches.rows[0].count
      }
    };
  }

  async getServers(filters = {}) {
    let query = 'SELECT * FROM mcp_servers WHERE 1=1';
    const args = [];

    if (filters.category) {
      query += ' AND category = ?';
      args.push(filters.category);
    }

    if (filters.minScore) {
      query += ' AND score >= ?';
      args.push(parseFloat(filters.minScore));
    }

    query += ' ORDER BY score DESC LIMIT 50';

    const result = await this.db.query(query, args);

    return {
      success: true,
      servers: result.rows.map(row => ({
        ...row,
        features: JSON.parse(row.features || '[]'),
        recommendations: JSON.parse(row.recommendations || '[]')
      }))
    };
  }

  async getServerById(id) {
    const result = await this.db.query('SELECT * FROM mcp_servers WHERE id = ?', [id]);

    if (result.rows.length === 0) {
      return { success: false, message: 'Not found' };
    }

    const server = result.rows[0];
    const matchesResult = await this.db.query('SELECT * FROM matches WHERE server_id = ?', [id]);

    return {
      success: true,
      server: {
        ...server,
        features: JSON.parse(server.features || '[]'),
        recommendations: JSON.parse(server.recommendations || '[]'),
        matches: matchesResult.rows
      }
    };
  }
}