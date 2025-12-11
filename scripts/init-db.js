// scripts/init-db.js - Initialize Turso Database Schema

import { createClient } from '@libsql/client';
import dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function initializeDatabase() {
  console.log('[DB INIT] Starting database initialization...');

  try {
    // Table: mcp_servers
    await client.execute(`
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
        notification_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        
        UNIQUE(repo_owner, repo_name)
      )
    `);
    console.log('[DB INIT] Table mcp_servers created');

    // Table: matches
    await client.execute(`
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
        notified_at TEXT,
        
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id)
      )
    `);
    console.log('[DB INIT] Table matches created');

    // Table: notifications
    await client.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        target_repo_owner TEXT NOT NULL,
        target_repo_name TEXT NOT NULL,
        issue_number INTEGER,
        issue_url TEXT,
        server_id TEXT,
        match_id TEXT,
        
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'sent'
      )
    `);
    console.log('[DB INIT] Table notifications created');

    // Table: api_keys (for multi-agent management)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        key TEXT NOT NULL,
        role TEXT,
        model TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[DB INIT] Table api_keys created');

    // Indexes for performance
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_servers_score ON mcp_servers(score DESC)
    `);
    
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_servers_category ON mcp_servers(category)
    `);
    
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status)
    `);
    
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_matches_relevance ON matches(relevance DESC)
    `);
    
    console.log('[DB INIT] Indexes created');

    console.log('[DB INIT] Database initialization completed successfully!');

  } catch (error) {
    console.error('[DB INIT] Error:', error.message);
    process.exit(1);
  }
}

initializeDatabase();