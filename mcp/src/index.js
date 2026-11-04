#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Cursor, …) spawns
   this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session ends.
   No extra container. The read tools make no network call; log_workout, once paired, talks to
   your own openGym server and nothing else — your data stays in a folder you control. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { WRITE_TOOLS } from './write-tools.js'
import { init, getUser, refresh, remoteMode } from './state.js'
import { ROUTINE_TOOLS } from './routine-tools.js'

const server = new McpServer({
  name: 'opengym',
  version: '0.1.0'
})

// Fail fast on bad config so a misnamed OPENGYM_DATA doesn't silently answer every call with
// the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
try {
  if (remoteMode()) await refresh()
  else init()
  const u = getUser()
  console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})${remoteMode() ? ' from ' + process.env.OPENGYM_URL : ''}`)
} catch (e) {
  console.error(`[opengym-mcp] ${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

for (const t of [...TOOLS, ...WRITE_TOOLS, ...ROUTINE_TOOLS]) {
  server.tool(
    t.name,
    t.description,
    t.schema,
    async (params) => {
      try {
        // log_workout talks to the server, so a handler may answer with a promise.
        // Remote mode: the profile as the server has it now (a no-op with a data directory).
        await refresh()
        const result = await t.handler(params || {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const code = err.code || 'ERROR'
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${err.message}` }]
        }
      }
    }
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
