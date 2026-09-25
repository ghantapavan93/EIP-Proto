# Operations — demo deployment with Cloudflare Quick Tunnel

One public URL, one public port. The browser only ever talks to the nginx
gateway, which serves the UI and proxies same-origin `/api/*` to FastAPI on the
internal Docker network. Nothing in the frontend knows `localhost:8000`.

```
viewer's browser
   │  https://<random>.trycloudflare.com
   ▼
cloudflared (this laptop) ──► 127.0.0.1:5173  nginx: static UI + /api proxy, security headers, rate limit
                                   │  http://api:8000 (Docker network only)
                                   ▼
                              FastAPI ──► Postgres (no host port)
                                     └──► Ollama on the host (optional; cassettes replay without it)
```

The UI port and the API's local `/docs` port are bound to `127.0.0.1`, so the
LAN cannot reach them either; Postgres has no host port at all.

**1. Real passwords first.** The tunnel script refuses to publish while any
account still has password == username. In `.env` (gitignored):

```
BACKSTOP_USERS=pavan:<long-password>:engineer,reviewer:<long-password>:analyst,admin:<long-password>:admin
```

Audit rows then read `pavan (engineer)`; automation reads `system:scanner`,
`system:runner`, … — no action is attributed to a person who did not take it.

**2. Start and verify** (builds, waits for health through the gateway, prints each component):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\demo-up.ps1          # add -Fresh to reseed from scratch
```

```bash
./scripts/demo-up.sh                                                   # --fresh to reseed
```

**3. Publish** (needs `cloudflared`: `winget install --id Cloudflare.cloudflared`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\demo-tunnel.ps1
```

```bash
./scripts/demo-tunnel.sh      # = cloudflared tunnel --url http://localhost:5173
```

The URL is printed by `cloudflared` and changes every start; nothing hardcodes it.

**Fallbacks, in order:** the current tunnel URL → rerun the tunnel script (new
URL, same data) → screen-share `http://localhost:5173`. The demo needs no
internet after the images are built: frozen page snapshots, recorded cassettes;
Ollama is optional.

**Long requests over the tunnel.** Runs execute synchronously inside the
request. Simulated and cassette runs return in seconds, but a *live* model run
over 60 calls takes 9–55 minutes, and Cloudflare closes a proxied request after
about 100 seconds (HTTP 524). The run still completes on the server and shows up
under Runs, but the browser that started it sees an error. Over a tunnel, start
live runs with `--limit 3` or from the CLI on the host; production would queue
them (the scheduled-task shape in `infra/terraform`).

**Quick Tunnel is for demos and development only** — random URL, no uptime
guarantee, no access control beyond the app's own login. Production would be a
named Cloudflare tunnel behind Cloudflare Access (SSO), or the ECS/RDS shape in
[`infra/terraform`](../infra/terraform) behind an ALB.
