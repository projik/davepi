# @davepi/mcp

One-line MCP wiring for [dAvePi](https://docs.davepi.dev). Connects
Claude Desktop / Cursor / Claude Code to a dAvePi instance — either
a remote HTTP `/mcp` endpoint or a local stdio session.

## Install / wire it up

You don't install — `npx -y` runs the latest published version on
demand.

### Claude Code (`.mcp.json` in the project root)

```json
{
  "mcpServers": {
    "davepi": {
      "command": "npx",
      "args": ["-y", "@davepi/mcp"],
      "env": {
        "DAVEPI_URL": "http://localhost:5050",
        "DAVEPI_TOKEN": "<long-lived-jwt>"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

macOS path: `~/Library/Application Support/Claude/claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "davepi": {
      "command": "npx",
      "args": ["-y", "@davepi/mcp"],
      "env": {
        "DAVEPI_URL": "https://api.example.com",
        "DAVEPI_TOKEN": "<long-lived-jwt>"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json` or settings)

```json
{
  "mcpServers": {
    "davepi": {
      "command": "npx",
      "args": ["-y", "@davepi/mcp"],
      "env": {
        "DAVEPI_URL": "https://api.example.com",
        "DAVEPI_TOKEN": "<long-lived-jwt>"
      }
    }
  }
}
```

## Modes

The wrapper picks one mode based on environment:

| Env vars | Mode | Use when |
|----------|------|----------|
| `DAVEPI_URL` + `DAVEPI_TOKEN` | HTTP-proxy | dAvePi is hosted (production deployment, demo instance, etc.) and the agent runs on a developer's laptop. |
| `DAVEPI_SCHEMAS` (or no env vars in a project with a `schema/versions/` directory) | Local-stdio | dAvePi is installed in the same project as the agent's working tree (`npm install davepi`). The wrapper spawns `davepi mcp` and pipes its stdio. |

Both modes are pure JSON-RPC pumps — neither holds any MCP-protocol
state, so a future MCP version doesn't require touching this
package.

## Issuing a long-lived JWT for `DAVEPI_TOKEN`

Run this on the dAvePi server (or anywhere with `TOKEN_KEY`):

```bash
node -e '
  const jwt = require("jsonwebtoken");
  console.log(jwt.sign(
    { user_id: "<your-user-id>", roles: ["user"] },
    process.env.TOKEN_KEY,
    { expiresIn: "30d" }
  ));
'
```

Treat the result like any other API credential.

## Documentation

- [Surfaces → MCP server](https://docs.davepi.dev/surfaces/mcp/) — the full MCP tool surface dAvePi exposes.
- [Concepts → Why agents come first](https://docs.davepi.dev/concepts/agent-first/) — why MCP is first-class.

## License

ISC. Source: <https://github.com/projik/davepi/tree/main/packages/mcp>.
