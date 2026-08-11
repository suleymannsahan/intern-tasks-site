# Graph Report - .  (2026-08-06)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 69 nodes · 80 edges · 15 communities (6 shown, 9 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1c970f9d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- server.js
- googleCalendar.js
- dependencies
- getUserGoogleToken
- better-sqlite3
- cors
- express
- @getbrevo/brevo
- jsonwebtoken
- @libsql/client
- nodemailer
- resend
- getSubordinateRoles

## God Nodes (most connected - your core abstractions)
1. `clientFromRefreshToken()` - 5 edges
2. `makeOAuthClient()` - 4 edges
3. `getUserGoogleToken()` - 4 edges
4. `buildEventBody()` - 3 edges
5. `createEvent()` - 3 edges
6. `updateEvent()` - 3 edges
7. `scripts` - 3 edges
8. `normalizeDateForGcal()` - 3 edges
9. `syncTaskToGoogle()` - 3 edges
10. `syncMeetingToGoogle()` - 3 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (15 total, 9 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.14
Nodes (13): author, description, engines, node, keywords, license, main, name (+5 more)

### Community 1 - "server.js"
Cohesion: 0.14
Nodes (8): app, bcrypt, cors, { createClient }, db, express, gcal, path

### Community 2 - "googleCalendar.js"
Cohesion: 0.29
Nodes (10): buildEventBody(), clientFromRefreshToken(), createEvent(), deleteEvent(), exchangeCodeForTokens(), getAuthUrl(), { google }, makeOAuthClient() (+2 more)

### Community 3 - "dependencies"
Cohesion: 0.40
Nodes (5): bcryptjs, googleapis, dependencies, bcryptjs, googleapis

### Community 4 - "getUserGoogleToken"
Cohesion: 0.50
Nodes (5): getUserGoogleToken(), normalizeDateForGcal(), removeTaskFromGoogle(), syncMeetingToGoogle(), syncTaskToGoogle()

## Knowledge Gaps
- **31 isolated node(s):** `{ google }`, `SCOPES`, `name`, `version`, `description` (+26 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `package.json`, `better-sqlite3`, `cors`, `express`, `@getbrevo/brevo`, `jsonwebtoken`, `@libsql/client`, `nodemailer`, `resend`?**
  _High betweenness centrality (0.202) - this node is a cross-community bridge._
- **What connects `{ google }`, `SCOPES`, `name` to the rest of the system?**
  _31 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._