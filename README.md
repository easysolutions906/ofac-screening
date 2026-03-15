# MCP OFAC Sanctions Screening

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for screening names against the US Treasury OFAC SDN (Specially Designated Nationals) list. Production-grade fuzzy matching with Jaro-Winkler, phonetic, and token-set algorithms.

## Why this exists

Every company processing USD transactions is legally required to screen against the OFAC sanctions list. Penalties for non-compliance start at $356,579 per violation. Enterprise screening tools cost $10,000-100,000/year. This server gives you the same capability for a fraction of the cost.

## Tools (5 total)

| Tool | Description |
|------|-------------|
| `ofac_screen` | Screen a name with fuzzy matching. Returns scored matches with confidence levels (exact/strong/partial/weak). Optionally filter by type, DOB, and country. |
| `ofac_screen_batch` | Screen up to 100 names in one call. Each name can include type, DOB, and country for improved accuracy. |
| `ofac_entity` | Get full details of an SDN entry by UID — aliases, addresses, IDs, programs, DOB, nationalities, vessel info. |
| `ofac_search` | Search/browse the SDN list by keyword, entity type, or sanctions program. |
| `ofac_stats` | List statistics — entries by type, program, top countries, data freshness. |

## Data

- **18,712 entries** from the OFAC SDN list (published 03/13/2026)
- **Entity types**: 9,521 entities, 7,394 individuals, 1,455 vessels, 342 aircraft
- **73 sanctions programs** (RUSSIA, SDGT, IRAN, CUBA, DPRK, CYBER2, etc.)
- Data updates available via `npm run build-data`

## Matching Algorithm

Multi-strategy fuzzy matching pipeline:

1. **Jaro-Winkler similarity** (40%) — handles transpositions and typos
2. **Token-set matching** (30%) — handles word reordering ("BANK OF IRAN" vs "IRAN BANK")
3. **Double Metaphone phonetic** (20%) — catches spelling variations of same-sounding names
4. **Exact substring** (10%) — partial name containment
5. **Exact token boost** — single-name queries like "PUTIN" match "Vladimir Vladimirovich PUTIN"
6. **DOB/country boost** — cross-reference date of birth and nationality to reduce false positives

Every result includes a confidence score, match type classification, and detailed breakdown explaining why it matched.

## Install

```bash
npx @easysolutions906/mcp-ofac
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ofac": {
      "command": "npx",
      "args": ["-y", "@easysolutions906/mcp-ofac"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ofac": {
      "command": "npx",
      "args": ["-y", "@easysolutions906/mcp-ofac"]
    }
  }
}
```

## REST API

Set `PORT` env var to run as an HTTP server:

```bash
PORT=3000 STRIPE_SECRET_KEY=sk_live_... ADMIN_SECRET=your_secret node src/index.js
```

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/screen` | Screen a single name |
| POST | `/screen/batch` | Screen multiple names (max 100) |
| GET | `/entity/:uid` | Get full SDN entry details |
| GET | `/search` | Search/browse the SDN list |
| GET | `/programs` | List all sanctions programs |
| GET | `/stats` | Data statistics |
| POST | `/checkout` | Create Stripe checkout session for paid plans |
| GET | `/data-info` | Data freshness and record counts |

### Example

```bash
curl -X POST https://your-server.com/screen \
  -H 'Content-Type: application/json' \
  -d '{"name": "PUTIN", "country": "Russia"}'
```

```json
{
  "matchCount": 1,
  "matches": [{
    "entity": {
      "name": "Vladimir Vladimirovich PUTIN",
      "sdnType": "Individual",
      "programs": ["RUSSIA-EO14024"],
      "title": "President of the Russian Federation"
    },
    "score": 0.86,
    "matchType": "strong",
    "matchedOn": "alias",
    "matchedName": "Vladimir PUTIN"
  }],
  "listVersion": "03/13/2026",
  "screenedAt": "2026-03-15T17:27:07.651Z"
}
```

## Pricing

| Plan | Screens/day | Batch | Rate | Price |
|------|------------|-------|------|-------|
| Free | 10 | 5 | 5/min | $0 |
| Starter | 100 | 25 | 15/min | $4.99/mo |
| Pro | 1,000 | 50 | 60/min | $29.99/mo |
| Business | 5,000 | 100 | 200/min | $99.99/mo |
| Enterprise | 50,000 | 100 | 500/min | $299.99/mo |

## Audit Trail

Every response includes `listVersion` (OFAC publish date) and `screenedAt` (ISO timestamp) for compliance documentation.

## Transport

- **stdio** (default) — for local use with Claude Desktop and Cursor
- **HTTP** — set `PORT` env var for Streamable HTTP mode on `/mcp`

## Disclaimer

This tool is provided for informational and screening purposes only. It does not constitute legal advice. Compliance decisions remain the responsibility of the user. Always consult qualified legal counsel for sanctions compliance matters.
