# T3 Self-hosted Relay images

An encrypted relay for environments and clients built from this T3 Code fork.
Hosts and clients connect outbound to one public HTTPS origin; hosts do not
need inbound ports or individual public domains. Official T3 clients do not
implement this connection mode.

## Choose an image

The fork's Release workflow publishes Linux amd64 images to GHCR when registry
publishing is enabled:

| Image                                           | Contents                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `ghcr.io/njzydark/t3code/selfhosted-relay:core` | Rust relay only                                                    |
| `ghcr.io/njzydark/t3code/selfhosted-relay:web`  | Same relay plus this fork's static web client, without source maps |

These are rolling tags. Prefer the versioned `:<version>-core` or
`:<version>-web` tag listed in your Release for reproducible deployments.
Neither image includes Node.js or a Rust compiler. Both listen on port `8788`
and provide `/healthz` for health checks.

Releases also attach Docker archives, so a registry is not required:

```bash
gzip -dc t3-selfhosted-relay-linux-amd64-web.tar.gz | docker load
```

Verify the Release checksums before importing. Use the image name recorded in
`relay-web-build.txt` (or `relay-core-build.txt`) to run the imported image.

## Start behind an HTTPS proxy

Generate a private host registration token and retain it in your deployment's
secret configuration. It is required and must be at least 32 characters:

```bash
export T3_RELAY_REGISTRATION_TOKEN="$(openssl rand -hex 32)"
docker run -d --name t3-relay --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --pids-limit 128 \
  -p 127.0.0.1:8788:8788 \
  -e T3_RELAY_REGISTRATION_TOKEN \
  ghcr.io/njzydark/t3code/selfhosted-relay:web
```

Configure your existing HTTPS proxy to forward to `127.0.0.1:8788`, preserving
WebSocket upgrades and long connections. HTTP is supported only for loopback
testing. For a complete deployment with automatic TLS, use the supplied
[Compose configuration](compose.yaml) and [Caddyfile](Caddyfile), following the
[deployment guide](../../docs/user/self-hosted-relay.md#run-the-relay).

## Connect hosts and devices

On each forked T3 host, open **Settings > Sharing & access > Self-hosted relay**
and enter the public HTTPS origin and the same registration token. Once
connected, use **Authorized clients > Create link > Self-hosted relay** to pair
another device. A Linux host can use the fork's CLI instead; see the
[host and CLI connection guide](../../docs/user/self-hosted-relay.md#connect-an-environment).

The registration token admits hosts to the relay; devices use private,
one-use pairing links instead. Never put either credential in an image or
share it publicly. The `web` image opens an unconnected client for new
visitors, not a public list of hosts. The `core` image does not serve web pages.

Connection state is in memory; restarting the relay drops active connections.
Host identity and T3 data stay on the host. Traffic is encrypted between host
and client, but browsers must trust the operator serving their web app.
Read the [trust and compatibility limits](../../docs/user/self-hosted-relay.md#trust-and-compatibility)
before exposing the service.
