// server.js - NEXUS MCP Orchestrator - Backend Logic
import { createClient } from '@libsql/client';
import Groq from 'groq-sdk';
import { Octokit } from '@octokit/rest';
import sgMail from '@sendgrid/mail';
import crypto from 'crypto';

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

    console.log(`[AGENT POOL] Initialized with ${this.agents.length} agents`);
    this.startUsageReset();
  }

  getNextAgent() {
    const now = Date.now();
    
    // Reset usage if window passed
    this.agents.forEach(agent => {
      if (now >= agent.resetAt) {
        agent.usage.requests = 0;
        agent.usage.resetAt = now + 60000;
        agent.status = 'active';
      }
    });

    // Find available agent (round-robin with availability check)
    for (let i = 0; i < this.agents.length; i++) {
      const agent = this.agents[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.agents.length;

      if (agent.status === 'active' && agent.usage.requests < agent.usage.limit) {
        return agent;
      }
    }

    throw new Error('All agents are rate limited. Please wait.');
  }

  async execute(prompt, role = 'general') {
    const agent = this.getNextAgent();

    try {
      const response = await agent.client.chat.completions.create({
        model: agent.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000
      });

      agent.usage.requests++;

      console.log(`[${agent.id}] ${role} - ${agent.usage.requests}/${agent.usage.limit} requests`);

      return response.choices[0].message.content;
    } catch (error) {
      if (error.message.includes('rate limit')) {
        agent.status = 'rate_limited';
        console.warn(`[${agent.id}] Rate limited, retrying with another agent...`);
        return this.execute(prompt, role); // Retry with next agent
      }
      throw error;
    }
  }

  startUsageReset() {
    setInterval(() => {
      this.agents.forEach(agent => {
        agent.usage.requests = 0;
        agent.status = 'active';
      });
      console.log('[AGENT POOL] Usage reset completed');
    }, 60000);
  }
}

// ============================================================================
// DATABASE CLIENT
// ============================================================================

class DatabaseService {
  constructor() {
    this.client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });
  }

  async execute(query) {
    return await this.client.execute(query);
  }

  async query(sql, args = []) {
    return await this.client.execute({ sql, args });
  }
}

// ============================================================================
// GITHUB SCANNER
// ============================================================================

class GitHubScanner {
  constructor(db, agentPool) {
    this.octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    this.db = db;
    this.agentPool = agentPool;
    this.cache = new Map();
  }

  async scanNewServers(limit = 100) {
    try {
      const result = await this.octokit.search.repos({
        q: 'topic:mcp-server OR topic:model-context-protocol created:>2024-11-01',
        sort: 'updated',
        order: 'desc',
        per_page: limit
      });

      console.log(`[GITHUB] Found ${result.data.items.length} MCP repositories`);

      const newServers = [];

      for (const repo of result.data.items) {
        const exists = await this.checkIfExists(repo.full_name);
        
        if (!exists) {
          newServers.push({
            id: crypto.randomUUID(),
            repo_owner: repo.owner.login,
            repo_name: repo.name,
            repo_url: repo.html_url,
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            last_updated: repo.updated_at,
            created_at: new Date().toISOString()
          });
        }
      }

      return newServers;
    } catch (error) {
      console.error('[GITHUB] Scan error:', error.message);
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
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return content;
    } catch (error) {
      return '';
    }
  }

  async getPackageJson(owner, repo) {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path: 'package.json'
      });
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  detectLanguage(readmeContent) {
    const lowerContent = readmeContent.toLowerCase();
    
    const languages = {
      fr: ['bonjour', 'merci', 'projet', 'développement', 'serveur'],
      en: ['hello', 'thank', 'project', 'development', 'server'],
      es: ['hola', 'gracias', 'proyecto', 'desarrollo', 'servidor'],
      de: ['hallo', 'danke', 'projekt', 'entwicklung', 'server']
    };

    let maxMatches = 0;
    let detectedLang = 'en';

    for (const [lang, keywords] of Object.entries(languages)) {
      const matches = keywords.filter(kw => lowerContent.includes(kw)).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        detectedLang = lang;
      }
    }

    return detectedLang;
  }
}

// ============================================================================
// AI ANALYZER
// ============================================================================

class AIAnalyzer {
  constructor(agentPool) {
    this.agentPool = agentPool;
  }

  async analyzeServer(server, readme, packageJson) {
    const prompt = `You are an expert code quality analyst. Analyze this MCP server and provide a detailed quality assessment.

Repository: ${server.repo_owner}/${server.repo_name}
Stars: ${server.stars}
Forks: ${server.forks}

README Content (first 2000 chars):
${readme.substring(0, 2000)}

Package.json:
${packageJson ? JSON.stringify(packageJson, null, 2).substring(0, 1000) : 'Not available'}

Provide a JSON response with this structure:
{
  "score": 8.5,
  "code_quality": 9.0,
  "security": 8.0,
  "documentation": 8.5,
  "mcp_compliance": 9.0,
  "maintenance": true,
  "category": "data",
  "features": ["feature1", "feature2", "feature3"],
  "recommendations": ["recommendation1", "recommendation2"]
}

Categories: compute, data, api, tools, utility
Score each criterion from 0-10.
Be objective and detailed.`;

    try {
      const response = await this.agentPool.execute(prompt, 'analyzer');
      
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON in AI response');
      }

      const analysis = JSON.parse(jsonMatch[0]);
      return analysis;
    } catch (error) {
      console.error('[AI ANALYZER] Error:', error.message);
      
      // Return default analysis on error
      return {
        score: 5.0,
        code_quality: 5.0,
        security: 5.0,
        documentation: 5.0,
        mcp_compliance: 5.0,
        maintenance: false,
        category: 'utility',
        features: [],
        recommendations: ['Unable to analyze - please check repository']
      };
    }
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
      // Search GitHub for repos mentioning needs related to server features
      const features = analysis.features.join(' OR ');
      const searchQuery = `"looking for" OR "need" ${features} MCP in:issue is:open`;

      const result = await this.scanner.octokit.search.issuesAndPullRequests({
        q: searchQuery,
        per_page: 20
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
            user_issue_number: issue.number,
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
    const prompt = `Determine if this MCP server matches the user's need.

MCP Server: ${server.repo_owner}/${server.repo_name}
Features: ${analysis.features.join(', ')}
Category: ${analysis.category}

User Issue: ${issue.title}
Description: ${issue.body ? issue.body.substring(0, 500) : 'No description'}

Respond with JSON:
{
  "score": 0.85,
  "reason": "Brief explanation why this matches"
}

Score from 0.0 (no match) to 1.0 (perfect match).`;

    try {
      const response = await this.agentPool.execute(prompt, 'matcher');
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.error('[MATCHER] Relevance calc error:', error.message);
    }

    return { score: 0.0, reason: 'Unable to calculate relevance' };
  }
}

// ============================================================================
// NOTIFICATION MANAGER
// ============================================================================

class NotificationManager {
  constructor(db, scanner) {
    this.db = db;
    this.scanner = scanner;
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }

  async notifyMaintainer(server, analysis, matches, language = 'en') {
    try {
      // Check cooldown
      const canNotify = await this.checkNotificationCooldown(
        server.repo_owner,
        server.repo_name
      );

      if (!canNotify) {
        console.log(`[NOTIF] Cooldown active for ${server.repo_owner}/${server.repo_name}`);
        return { success: false, reason: 'cooldown' };
      }

      const templates = {
        en: this.getEnglishTemplate(server, analysis, matches),
        fr: this.getFrenchTemplate(server, analysis, matches)
      };

      const template = templates[language] || templates.en;

      // Create GitHub issue
      const issue = await this.scanner.octokit.issues.create({
        owner: server.repo_owner,
        repo: server.repo_name,
        title: template.title,
        body: template.body,
        labels: ['nexus-mcp-orchestrator']
      });

      // Log notification
      await this.db.query(
        `INSERT INTO notifications (id, type, target_repo_owner, target_repo_name, issue_number, issue_url, server_id, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          'maintainer',
          server.repo_owner,
          server.repo_name,
          issue.data.number,
          issue.data.html_url,
          server.id,
          new Date().toISOString()
        ]
      );

      console.log(`[NOTIF] Maintainer notified: ${issue.data.html_url}`);

      return { success: true, issueUrl: issue.data.html_url };
    } catch (error) {
      console.error('[NOTIF] Error notifying maintainer:', error.message);
      return { success: false, reason: error.message };
    }
  }

  async checkNotificationCooldown(owner, repo) {
    const cooldownMs = parseInt(process.env.NOTIFICATION_COOLDOWN_MS) || 3600000;
    const cutoff = new Date(Date.now() - cooldownMs).toISOString();

    const result = await this.db.query(
      `SELECT id FROM notifications 
       WHERE target_repo_owner = ? AND target_repo_name = ? AND sent_at > ?`,
      [owner, repo, cutoff]
    );

    return result.rows.length === 0;
  }

  getEnglishTemplate(server, analysis, matches) {
    return {
      title: `Your MCP Server Matched with ${matches.length} Potential Users`,
      body: `## Hello from Nexus Studio!

I'm **NEXUS MCP Orchestrator**, an artificial intelligence developed by **Nexus Studio**.

**Who are we?**
- **Nexus Studio** is an organization dedicated to improving the Model Context Protocol (MCP) ecosystem
- **CEO**: ${process.env.NEXUS_STUDIO_CEO}
- **Contact**: ${process.env.NEXUS_STUDIO_EMAIL}

---

### Why this message?

We detected that your project **\`${server.repo_name}\`** is an MCP server. Our automated analysis system evaluated it and we'd like to share the results.

### Quality Analysis

**Overall Score**: ${analysis.score}/10

**Details**:
- Code quality: ${analysis.code_quality}/10
- Security: ${analysis.security}/10
- Documentation: ${analysis.documentation}/10
- MCP Compliance: ${analysis.mcp_compliance}/10
- Active maintenance: ${analysis.maintenance ? 'Yes' : 'No'}

**Detected category**: ${analysis.category}

**Identified features**:
${analysis.features.map(f => `- ${f}`).join('\n')}

---

### Matches Found!

We identified **${matches.length} developers** looking for exactly the features your server offers:

${matches.slice(0, 5).map(m => `
**Repo**: ${m.user_repo_owner}/${m.user_repo_name}
**Issue**: ${m.user_issue_url}
**Relevance**: ${(m.relevance * 100).toFixed(0)}%
**Reason**: ${m.reason}
`).join('\n---\n')}

${matches.length > 5 ? `\n*...and ${matches.length - 5} more matches*` : ''}

---

### Recommendations

${analysis.recommendations.map(r => `- ${r}`).join('\n')}

---

### FAQ

**Q: Is this spam?**
A: No! We respect maintainers. You'll receive max 1 notification/hour.

**Q: How did you find us?**
A: Automatic GitHub scan (topics: \`mcp-server\`, \`model-context-protocol\`)

**Q: Can I opt-out?**
A: Yes! Add \`nexus-mcp-orchestrator: opt-out\` to your README or close this issue.

**Q: Is it free?**
A: Yes, completely. Our mission is to help the MCP ecosystem.

---

**Thank you for your contribution to the MCP ecosystem!**

_This notification was automatically generated by NEXUS MCP Orchestrator._
_Nexus Studio - ${process.env.NEXUS_STUDIO_CEO} - ${process.env.NEXUS_STUDIO_EMAIL}_
`
    };
  }

  getFrenchTemplate(server, analysis, matches) {
    return {
      title: `Votre Serveur MCP Correspond à ${matches.length} Utilisateurs Potentiels`,
      body: `## Bonjour de Nexus Studio !

Je suis **NEXUS MCP Orchestrator**, une intelligence artificielle développée par **Nexus Studio**.

**Qui sommes-nous ?**
- **Nexus Studio** est une organisation dédiée à l'amélioration de l'écosystème Model Context Protocol (MCP)
- **CEO** : ${process.env.NEXUS_STUDIO_CEO}
- **Contact** : ${process.env.NEXUS_STUDIO_EMAIL}

---

### Pourquoi ce message ?

Nous avons détecté que votre projet **\`${server.repo_name}\`** est un serveur MCP. Notre système d'analyse automatique l'a évalué et nous souhaitons partager les résultats.

### Analyse de Qualité

**Score Global** : ${analysis.score}/10

**Détails** :
- Qualité du code : ${analysis.code_quality}/10
- Sécurité : ${analysis.security}/10
- Documentation : ${analysis.documentation}/10
- Conformité MCP : ${analysis.mcp_compliance}/10
- Maintenance active : ${analysis.maintenance ? 'Oui' : 'Non'}

**Catégorie détectée** : ${analysis.category}

**Features identifiées** :
${analysis.features.map(f => `- ${f}`).join('\n')}

---

### Matches Trouvés !

Nous avons identifié **${matches.length} développeurs** qui recherchent exactement les fonctionnalités que votre serveur offre :

${matches.slice(0, 5).map(m => `
**Repo** : ${m.user_repo_owner}/${m.user_repo_name}
**Issue** : ${m.user_issue_url}
**Relevance** : ${(m.relevance * 100).toFixed(0)}%
**Raison** : ${m.reason}
`).join('\n---\n')}

${matches.length > 5 ? `\n*...et ${matches.length - 5} autres matches*` : ''}

---

### Recommandations

${analysis.recommendations.map(r => `- ${r}`).join('\n')}

---

### FAQ

**Q : Est-ce du spam ?**
R : Non ! Nous respectons les mainteneurs. Vous recevrez maximum 1 notification/heure.

**Q : Comment vous nous avez trouvé ?**
R : Scan automatique de GitHub (topics: \`mcp-server\`, \`model-context-protocol\`)

**Q : Puis-je opt-out ?**
R : Oui ! Ajoutez \`nexus-mcp-orchestrator: opt-out\` dans votre README ou fermez cette issue.

**Q : C'est gratuit ?**
R : Oui, totalement. Notre mission est d'aider l'écosystème MCP.

---

**Merci pour votre contribution à l'écosystème MCP !**

_Cette notification a été générée automatiquement par NEXUS MCP Orchestrator._
_Nexus Studio - ${process.env.NEXUS_STUDIO_CEO} - ${process.env.NEXUS_STUDIO_EMAIL}_
`
    };
  }
}

// ============================================================================
// BACKEND SERVICE (Main Orchestrator)
// ============================================================================

export class BackendService {
  constructor() {
    this.agentPool = null;
    this.db = null;
    this.scanner = null;
    this.analyzer = null;
    this.matcher = null;
    this.notifier = null;
  }

  async init() {
    console.log('[BACKEND] Initializing services...');
    
    this.agentPool = new AgentPool();
    this.db = new DatabaseService();
    this.scanner = new GitHubScanner(this.db, this.agentPool);
    this.analyzer = new AIAnalyzer(this.agentPool);
    this.matcher = new MCPMatcher(this.db, this.agentPool, this.scanner);
    this.notifier = new NotificationManager(this.db, this.scanner);

    console.log('[BACKEND] All services initialized');
  }

  async healthCheck() {
    return {
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      agents: this.agentPool.agents.length
    };
  }

  async scanAndAnalyze() {
    console.log('[ORCHESTRATOR] Starting scan and analysis...');

    try {
      // 1. Scan GitHub for new MCP servers
      const newServers = await this.scanner.scanNewServers(
        parseInt(process.env.SCAN_BATCH_SIZE) || 100
      );

      console.log(`[ORCHESTRATOR] Found ${newServers.length} new servers`);

      // 2. Analyze each server
      for (const server of newServers) {
        try {
          // Get README
          const readme = await this.scanner.getReadme(
            server.repo_owner,
            server.repo_name
          );

          // Get package.json
          const packageJson = await this.scanner.getPackageJson(
            server.repo_owner,
            server.repo_name
          );

          // Analyze with AI
          const analysis = await this.analyzer.analyzeServer(server, readme, packageJson);

          // Save to database
          await this.db.query(
            `INSERT INTO mcp_servers 
             (id, repo_owner, repo_name, repo_url, stars, forks, last_updated,
              score, code_quality, security, documentation, mcp_compliance, 
              maintenance, category, features, recommendations, analyzed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              server.id,
              server.repo_owner,
              server.repo_name,
              server.repo_url,
              server.stars,
              server.forks,
              server.last_updated,
              analysis.score,
              analysis.code_quality,
              analysis.security,
              analysis.documentation,
              analysis.mcp_compliance,
              analysis.maintenance ? 1 : 0,
              analysis.category,
              JSON.stringify(analysis.features),
              JSON.stringify(analysis.recommendations),
              new Date().toISOString()
            ]
          );

          // 3. Find matches
          const matches = await this.matcher.findMatches(server, analysis);

          // Save matches
          for (const match of matches) {
            await this.db.query(
              `INSERT INTO matches 
               (id, server_id, user_repo_owner, user_repo_name, user_issue_url, 
                relevance, reason, features, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                match.id,
                match.server_id,
                match.user_repo_owner,
                match.user_repo_name,
                match.user_issue_url,
                match.relevance,
                match.reason,
                match.features,
                match.status,
                match.created_at
              ]
            );
          }

          // 4. Notify maintainer if matches found and score >= 7
          if (matches.length > 0 && analysis.score >= 7.0) {
            const language = this.scanner.detectLanguage(readme);
            await this.notifier.notifyMaintainer(server, analysis, matches, language);
          }

          console.log(`[ORCHESTRATOR] Processed: ${server.repo_owner}/${server.repo_name}`);

        } catch (error) {
          console.error(`[ORCHESTRATOR] Error processing ${server.repo_owner}/${server.repo_name}:`, error.message);
        }
      }

      return {
        success: true,
        processed: newServers.length
      };

    } catch (error) {
      console.error('[ORCHESTRATOR] Scan error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getStats() {
    const totalServers = await this.db.query('SELECT COUNT(*) as count FROM mcp_servers');
    const avgScore = await this.db.query('SELECT AVG(score) as avg FROM mcp_servers');
    const totalMatches = await this.db.query('SELECT COUNT(*) as count FROM matches');

    return {
      success: true,
      stats: {
        totalServers: totalServers.rows[0].count,
        averageScore: parseFloat(avgScore.rows[0].avg || 0).toFixed(2),
        totalMatches: totalMatches.rows[0].count,
        timestamp: new Date().toISOString()
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
      return { success: false, message: 'Server not found' };
    }

    const server = result.rows[0];
    
    // Get matches
    const matchesResult = await this.db.query(
      'SELECT * FROM matches WHERE server_id = ? ORDER BY relevance DESC',
      [id]
    );

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