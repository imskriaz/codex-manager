# Cloudflare Tunnel setup

This guide publishes the Codex Manager browser dashboard over HTTPS. The extension serves HTTP and WebSocket traffic on `127.0.0.1:39875`; Cloudflare Tunnel forwards that traffic to a hostname you control.

Cloudflare Tunnel is outbound-only: `cloudflared` connects from your PC to Cloudflare, so no inbound port needs to be opened. It does not tunnel raw MQTT/TCP. Keep any MQTT broker on its own secured endpoint.

## Before you start

- Enable **Web dashboard** in Codex Manager.
- Set the shared Password in General; encrypted sync and remote dashboard login use it.
- Keep the dashboard host running, or enable **Always-online WebSocket host** on an always-on PC.
- Own a domain managed by Cloudflare and install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

## Quick Tunnel (testing only)

Quick Tunnels create a temporary random `trycloudflare.com` hostname. They are for development and demonstrations, not production accounts.

```powershell
cloudflared tunnel --url http://127.0.0.1:39875
```

Copy the URL printed in the terminal, open it in a browser, and use the shared password. Keep this terminal running. A Quick Tunnel is not stable and does not provide a custom DNS name.

See Cloudflare’s [Quick Tunnels documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Named tunnel (recommended)

### Dashboard method

1. Open **Cloudflare Dashboard → Networking → Tunnels**.
2. Select **Create a tunnel**, name it, choose **Windows**, and copy the connector command.
3. Run the command on the same PC as Codex Manager. Wait for the tunnel to show **Healthy**.
4. On the tunnel’s **Routes** tab, choose **Add route → Published application**.
5. Choose your domain, enter a hostname such as `codex.example.com`, and set the service URL to `http://127.0.0.1:39875`.
6. Save the route. Set `codexManager.cloudflaredDomain` to `https://codex.example.com`.

Cloudflare’s [create a tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) includes current dashboard labels and connector commands.

### Local configuration method

Use this when you want the tunnel configuration in a local YAML file:

```powershell
cloudflared tunnel login
cloudflared tunnel create codex-manager
cloudflared tunnel route dns codex-manager codex.example.com
```

Create `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-uuid>.json

ingress:
  - hostname: codex.example.com
    service: http://127.0.0.1:39875
  - service: http_status:404
```

Validate and run it:

```powershell
cloudflared tunnel ingress validate
cloudflared tunnel run codex-manager
```

To run it as a Windows service, use an elevated terminal and follow Cloudflare’s [service installation instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/). Protect the credentials file; it authorizes the tunnel.

## Verify the complete path

1. On the host PC, open `http://127.0.0.1:39875` and confirm the dashboard loads.
2. From another network, open `https://codex.example.com` and confirm the password prompt appears.
3. Sign in and check that live dashboard updates work; this validates WebSocket forwarding as well as HTTP.

If the public page fails, check that the local dashboard is enabled, the service URL uses port `39875`, the tunnel is **Healthy**, and Windows Firewall or proxy rules allow `cloudflared` outbound access. Cloudflare recommends checking connectivity to port `7844`; see the [Tunnel troubleshooting docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

## Security checklist

- Use a named tunnel and HTTPS hostname for real accounts.
- Keep the shared password protected and use the same value on every participating PC.
- Add a [Cloudflare Access application](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/) when the hostname should be restricted to specific users.
- Do not publish `auth.json`, SecretStorage, the VS Code port, or an MQTT listener.
- Revoke the tunnel in Cloudflare if the connector credential is exposed.
