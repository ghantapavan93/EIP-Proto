# Scripts

Helper scripts that start the Docker stack for a demo, check that it is ready, and optionally publish the UI through a Cloudflare Quick Tunnel.

All scripts change to the repository root first, so they can be run from anywhere. They use the UI gateway port from `BACKSTOP_UI_PORT` (default `5173`), except `demo-keepalive.ps1`, which always uses `http://localhost:5173`.

| Script | Platform | Purpose |
|---|---|---|
| `demo-up.ps1` | Windows PowerShell | Build and start the stack, wait until it is ready, print component health. |
| `demo-up.sh` | bash (Linux, macOS, Git Bash) | Same as `demo-up.ps1`. |
| `demo-tunnel.ps1` | Windows PowerShell | Publish the UI gateway through a Cloudflare Quick Tunnel. |
| `demo-tunnel.sh` | bash | Same as `demo-tunnel.ps1`. |
| `demo-keepalive.ps1` | Windows PowerShell | Keep the stack and one Quick Tunnel running unattended for a set number of hours. |
| `preflight.ps1` | Windows PowerShell | Read-only go/no-go before sending the link: stack health, corpus, calls, passwords, anonymous 401, public pages. |

## demo-up.ps1 and demo-up.sh

Runs `docker compose up --build -d`, then polls `http://localhost:<port>/api/health/deep` through the UI gateway (the path a viewer uses) every 2 seconds, for up to 180 seconds, until it reports `ready`. It then prints each component's state and the overall status.

- **Prerequisites:** Docker with Compose. The bash version also needs `curl` and `python3` or `python`.
- **Refuses:** nothing. If the demo accounts still use password equal to username, it prints a note that this is acceptable on localhost only.
- **Fails:** if the stack is not ready after 180 seconds, and points to `docker compose logs api`.
- **Destructive option:** `-Fresh` / `--fresh` runs `docker compose down -v` first, which deletes the database volume. The demo data is reseeded on start; anything else in that database is lost.

```
powershell -ExecutionPolicy Bypass -File scripts\demo-up.ps1 [-Fresh]
./scripts/demo-up.sh [--fresh]
```

## demo-tunnel.ps1 and demo-tunnel.sh

Publishes `http://localhost:<port>` (the UI and `/api` behind it) with `cloudflared tunnel --url`. Postgres, the API port and Ollama are not exposed. A Quick Tunnel gets a random `*.trycloudflare.com` URL, a new one on every start, with no uptime guarantee.

- **Prerequisites:** `cloudflared` on the PATH (the PowerShell version also accepts `%LOCALAPPDATA%\Programs\cloudflared\cloudflared.exe`), and a running stack. The bash version also needs `curl` and Python.
- **Refuses:** to publish while `/api/health/deep` reports `default_credentials` (any account whose password equals its username). Set real passwords in `BACKSTOP_USERS` in `.env`, then restart the API with `docker compose up -d api`.
- **Fails:** if `cloudflared` is missing or the stack is not answering.

```
powershell -ExecutionPolicy Bypass -File scripts\demo-tunnel.ps1
./scripts/demo-tunnel.sh
```

## demo-keepalive.ps1

Keeps a public demo available for a number of hours (default 6):

- Asks Windows not to idle-sleep for as long as the script runs (`SetThreadExecutionState`). Power settings are not changed, and closing the lid still sleeps the machine.
- Starts one Quick Tunnel and writes its URL to `.demo-link.txt` at the repository root. Events are logged to `.demo-keepalive.log`.
- Every 60 seconds, checks the local stack and the public URL. Runs `docker compose up -d` if the API stops answering. Restarts the tunnel if its process exits or the public URL fails three checks in a row. A restarted tunnel has a new URL; the old link stops working.
- Leaves the tunnel running when the time is up.

- **Prerequisites:** Windows, Docker with Compose, `cloudflared` (on the PATH or at the portable location above).
- **Refuses:** the same as `demo-tunnel.ps1`. Before every tunnel start it checks `/api/health/deep` and does not publish while `default_credentials` is reported or the stack is unhealthy; it logs the refusal and retries on the next check.

```
powershell -ExecutionPolicy Bypass -File scripts\demo-keepalive.ps1 [-Hours 3]
```

## preflight.ps1

Read-only; safe while reviewers are signed in. Checks deep health, the rule corpus and
inventory, the development and held-out calls, that no account has a default password,
that the API refuses anonymous requests, and that the public link serves `/`,
`/runs/compare`, `/governance` and `/api/health`. Exits 1 on the first failed group.

```
powershell -ExecutionPolicy Bypass -File scripts\preflight.ps1
```

A production deployment would use a named tunnel behind Cloudflare Access or a normal cloud deployment, not a Quick Tunnel. See [../docs/operations.md](../docs/operations.md).
