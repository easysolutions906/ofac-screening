#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  screenName,
  searchEntries,
  getEntity,
  listPrograms,
  buildStats,
} from './match.js';

import {
  PLANS,
  authMiddleware,
  incrementUsage,
  createKey,
  revokeKey,
} from './keys.js';

import { createCheckoutSession, handleWebhook } from './stripe.js';

// --- Load data ---

const DATA_DIR = new URL('./data/', import.meta.url).pathname;

const loadData = async () => {
  const [sdnRaw, metaRaw] = await Promise.all([
    readFile(`${DATA_DIR}sdn.json`, 'utf-8'),
    readFile(`${DATA_DIR}meta.json`, 'utf-8'),
  ]);
  return {
    entries: JSON.parse(sdnRaw),
    meta: JSON.parse(metaRaw),
  };
};

const { entries, meta } = await loadData();
console.log(`Loaded ${entries.length} SDN entries (published ${meta.publishDate})`);

// --- Shared response envelope ---

const auditFields = () => ({
  listVersion: meta.publishDate,
  screenedAt: new Date().toISOString(),
});

// --- Express API ---

const buildExpressApp = () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
    });
    next();
  });

  // GET / — API info
  app.get('/', (_req, res) => {
    res.json({
      name: 'OFAC Sanctions Screening API',
      version: '1.0.0',
      description: 'Screen names against the US Treasury OFAC SDN list with advanced fuzzy matching',
      dataVersion: meta.publishDate,
      totalEntries: meta.recordCount,
      endpoints: {
        'GET /': 'API info and endpoint list',
        'GET /health': 'Health check',
        'GET /data-info': 'Data build date, record counts, OFAC publish date',
        'POST /screen': 'Screen a single name against the SDN list',
        'POST /screen/batch': 'Screen multiple names (max 100)',
        'GET /entity/:uid': 'Get full details of an SDN entry by UID',
        'GET /search?q=keyword&type=Individual&program=SDGT&limit=25': 'Search/browse the SDN list',
        'GET /programs': 'List all sanctions programs with entry counts',
        'GET /stats': 'Statistics: entries by type, program, top countries',
      },
    });
  });

  // GET /health
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), entries: entries.length });
  });

  // GET /data-info
  app.get('/data-info', (_req, res) => {
    res.json({
      publishDate: meta.publishDate,
      buildDate: meta.buildDate,
      recordCount: meta.recordCount,
      typeCounts: meta.typeCounts,
      aliasCount: meta.aliasCount,
      addressCount: meta.addressCount,
    });
  });

  // POST /screen — single name screening (key-gated)
  app.post('/screen', authMiddleware, (req, res) => {
    const { name, type, dateOfBirth, country, threshold = 0.85, limit = 10 } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Request body must include a non-empty "name" string' });
    }

    if (threshold < 0 || threshold > 1) {
      return res.status(400).json({ error: 'Threshold must be between 0 and 1' });
    }

    const clampedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

    const matches = screenName(name, entries, {
      type: type || null,
      dateOfBirth: dateOfBirth || null,
      country: country || null,
      threshold,
      limit: clampedLimit,
    });

    incrementUsage(req.identifier, 1);

    res.json({
      query: { name, type: type || null, dateOfBirth: dateOfBirth || null, country: country || null },
      threshold,
      matchCount: matches.length,
      matches,
      plan: req.planName,
      ...auditFields(),
    });
  });

  // POST /screen/batch — batch screening (key-gated)
  app.post('/screen/batch', authMiddleware, (req, res) => {
    const { names, threshold = 0.85, limit = 10 } = req.body || {};

    if (!names || !Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "names" array' });
    }

    if (names.length > req.plan.batchLimit) {
      return res.status(400).json({
        error: `Maximum ${req.plan.batchLimit} names per batch on ${req.planName} plan`,
        limit: req.plan.batchLimit,
        upgrade: req.planName === 'free' ? 'Add an API key to increase batch size' : null,
      });
    }

    const clampedLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

    const results = names.map((item) => {
      const nameStr = typeof item === 'string' ? item : item?.name;

      if (!nameStr || typeof nameStr !== 'string' || !nameStr.trim()) {
        return { query: { name: nameStr || null }, error: 'Invalid name' };
      }

      const matches = screenName(nameStr, entries, {
        type: (typeof item === 'object' ? item.type : null) || null,
        dateOfBirth: (typeof item === 'object' ? item.dateOfBirth : null) || null,
        country: (typeof item === 'object' ? item.country : null) || null,
        threshold,
        limit: clampedLimit,
      });

      return {
        query: {
          name: nameStr,
          type: (typeof item === 'object' ? item.type : null) || null,
          dateOfBirth: (typeof item === 'object' ? item.dateOfBirth : null) || null,
          country: (typeof item === 'object' ? item.country : null) || null,
        },
        matchCount: matches.length,
        matches,
      };
    });

    incrementUsage(req.identifier, names.length);

    res.json({
      total: results.length,
      threshold,
      results,
      plan: req.planName,
      ...auditFields(),
    });
  });

  // GET /entity/:uid
  app.get('/entity/:uid', (req, res) => {
    const uid = parseInt(req.params.uid, 10);

    if (isNaN(uid)) {
      return res.status(400).json({ error: 'UID must be a number' });
    }

    const entity = getEntity(entries, uid);

    if (!entity) {
      return res.status(404).json({ error: `No SDN entry found with UID ${uid}` });
    }

    res.json({ entity, ...auditFields() });
  });

  // GET /search
  app.get('/search', (req, res) => {
    const { q, type, program } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const result = searchEntries(entries, { q, type, program, limit, offset });

    res.json({ ...result, ...auditFields() });
  });

  // GET /programs
  app.get('/programs', (_req, res) => {
    res.json({ ...listPrograms(meta), ...auditFields() });
  });

  // GET /stats
  app.get('/stats', (_req, res) => {
    res.json({ ...buildStats(entries, meta), ...auditFields() });
  });

  // --- Admin endpoints (require ADMIN_SECRET env var) ---

  const adminAuth = (req, res, next) => {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) { return res.status(503).json({ error: 'Admin not configured' }); }
    if (req.headers['x-admin-secret'] !== secret) {
      return res.status(401).json({ error: 'Invalid admin secret' });
    }
    next();
  };

  app.post('/admin/keys', adminAuth, (req, res) => {
    const { plan = 'pro', email = null } = req.body || {};
    if (!PLANS[plan]) {
      return res.status(400).json({ error: `Invalid plan. Options: ${Object.keys(PLANS).join(', ')}` });
    }
    const result = createKey(plan, email);
    res.json(result);
  });

  app.delete('/admin/keys/:key', adminAuth, (req, res) => {
    const revoked = revokeKey(req.params.key);
    res.json({ revoked });
  });

  app.get('/admin/plans', adminAuth, (_req, res) => {
    res.json(PLANS);
  });

  // --- Checkout endpoint ---

  app.post('/checkout', async (req, res) => {
    const { plan, successUrl, cancelUrl } = req.body || {};
    if (!plan || !PLANS[plan] || plan === 'free') {
      return res.status(400).json({
        error: `Invalid plan. Options: ${Object.keys(PLANS).filter((p) => p !== 'free').join(', ')}`,
      });
    }
    try {
      const session = await createCheckoutSession(plan, successUrl, cancelUrl);
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Stripe webhook ---

  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    try {
      const result = handleWebhook(req.body.toString(), req.headers['stripe-signature']);
      res.json({ received: true, result: result || null });
    } catch (err) {
      console.error('Stripe webhook error:', err.message);
      res.status(400).json({ error: 'Webhook processing failed' });
    }
  });

  return app;
};

// --- MCP Server ---

const buildMcpServer = () => {
  const server = new McpServer({
    name: 'ofac-sanctions',
    version: '1.0.0',
  });

  server.tool(
    'ofac_screen',
    'Screen a name against the OFAC SDN (Specially Designated Nationals) sanctions list with fuzzy matching. Returns scored matches with match type classification (exact/strong/partial/weak). Essential for KYC/AML compliance checks.',
    {
      name: z.string().describe('Name to screen (person, entity, vessel, or aircraft)'),
      type: z.enum(['Individual', 'Entity', 'Vessel', 'Aircraft']).optional().describe('Filter by SDN entry type'),
      dateOfBirth: z.string().optional().describe('Date of birth to improve accuracy (e.g., "1970-01-15" or "1970")'),
      country: z.string().optional().describe('Country to improve accuracy (e.g., "Iran", "Russia")'),
      threshold: z.number().optional().describe('Minimum match score 0-1 (default 0.85)'),
      limit: z.number().optional().describe('Maximum results to return (default 10)'),
    },
    async ({ name, type, dateOfBirth, country, threshold, limit }) => {
      const matches = screenName(name, entries, {
        type: type || null,
        dateOfBirth: dateOfBirth || null,
        country: country || null,
        threshold: threshold ?? 0.85,
        limit: limit ?? 10,
      });

      const result = {
        query: { name, type: type || null, dateOfBirth: dateOfBirth || null, country: country || null },
        threshold: threshold ?? 0.85,
        matchCount: matches.length,
        matches,
        ...auditFields(),
      };

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'ofac_screen_batch',
    'Screen multiple names against the OFAC SDN list in one call. Max 100 names. Each name can optionally include type, dateOfBirth, and country for improved accuracy.',
    {
      names: z.array(z.union([
        z.string(),
        z.object({
          name: z.string(),
          type: z.enum(['Individual', 'Entity', 'Vessel', 'Aircraft']).optional(),
          dateOfBirth: z.string().optional(),
          country: z.string().optional(),
        }),
      ])).describe('Array of names (strings or objects with name/type/dateOfBirth/country)'),
      threshold: z.number().optional().describe('Minimum match score 0-1 (default 0.85)'),
      limit: z.number().optional().describe('Maximum results per name (default 10)'),
    },
    async ({ names, threshold, limit }) => {
      const clampedLimit = Math.min(Math.max(limit ?? 10, 1), 100);
      const th = threshold ?? 0.85;

      const results = names.map((item) => {
        const nameStr = typeof item === 'string' ? item : item?.name;
        if (!nameStr) { return { query: { name: null }, error: 'Invalid name' }; }

        const matches = screenName(nameStr, entries, {
          type: (typeof item === 'object' ? item.type : null) || null,
          dateOfBirth: (typeof item === 'object' ? item.dateOfBirth : null) || null,
          country: (typeof item === 'object' ? item.country : null) || null,
          threshold: th,
          limit: clampedLimit,
        });

        return {
          query: { name: nameStr },
          matchCount: matches.length,
          matches,
        };
      });

      const result = { total: results.length, threshold: th, results, ...auditFields() };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'ofac_entity',
    'Get full details of an SDN entry by its unique ID (UID). Returns all fields: name, aliases, addresses, IDs, programs, dates of birth, nationalities, vessel info, and remarks.',
    {
      uid: z.number().describe('The unique SDN entry UID'),
    },
    async ({ uid }) => {
      const entity = getEntity(entries, uid);
      if (!entity) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `No SDN entry found with UID ${uid}` }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ entity, ...auditFields() }, null, 2) }] };
    },
  );

  server.tool(
    'ofac_search',
    'Search and browse the OFAC SDN list by keyword, entry type, or sanctions program. Supports pagination. Use for exploratory queries or browsing entries.',
    {
      q: z.string().optional().describe('Search keyword (searches names and aliases)'),
      type: z.enum(['Individual', 'Entity', 'Vessel', 'Aircraft']).optional().describe('Filter by entry type'),
      program: z.string().optional().describe('Filter by sanctions program (e.g., "SDGT", "IRAN", "CUBA")'),
      limit: z.number().optional().describe('Results per page (default 25, max 200)'),
      offset: z.number().optional().describe('Number of results to skip for pagination'),
    },
    async ({ q, type, program, limit, offset }) => {
      const result = searchEntries(entries, {
        q: q || '',
        type: type || null,
        program: program || null,
        limit: Math.min(Math.max(limit ?? 25, 1), 200),
        offset: Math.max(offset ?? 0, 0),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, ...auditFields() }, null, 2) }] };
    },
  );

  server.tool(
    'ofac_stats',
    'Get OFAC SDN list statistics: total entries, entries by type, entries by sanctions program, data version info, and top countries.',
    {},
    async () => {
      const stats = buildStats(entries, meta);
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    },
  );

  return server;
};

// --- Start ---

const main = async () => {
  const port = process.env.PORT;

  if (port) {
    // HTTP mode: Express REST API + MCP streamable HTTP
    const app = buildExpressApp();
    const mcpServer = buildMcpServer();
    const transports = {};

    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      let transport = transports[sessionId];

      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };
        await mcpServer.connect(transport);
        transports[transport.sessionId] = transport;
      }

      await transport.handleRequest(req, res, req.body);
    });

    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      const transport = transports[sessionId];
      if (!transport) {
        res.status(400).json({ error: 'No active session. Send a POST to /mcp first.' });
        return;
      }
      await transport.handleRequest(req, res);
    });

    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      const transport = transports[sessionId];
      if (!transport) {
        res.status(400).json({ error: 'No active session.' });
        return;
      }
      await transport.handleRequest(req, res);
    });

    app.listen(parseInt(port, 10), () => {
      console.log(`OFAC Sanctions Screening API running on port ${port}`);
      console.log(`REST endpoints: http://localhost:${port}/`);
      console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    });
  } else {
    // Stdio mode: MCP only
    const mcpServer = buildMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
  }
};

main().catch((err) => {
  console.error('Failed to start OFAC server:', err);
  process.exit(1);
});
