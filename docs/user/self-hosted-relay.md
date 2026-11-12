# Self-hosted relay

This fork can connect your T3 environments through one public HTTPS relay.
Each host and client makes an outbound WebSocket connection; hosts do not need
inbound ports or individual public domains. The default relay image also serves
this fork's web app; the `-core` image runs only the relay.

Use clients built from this fork, including a new native build for iOS or
Android. Official T3 clients do not implement this connection mode.

## Run the relay

Point a domain at your VPS. Copy `infra/selfhosted-relay/compose.yaml` and
`Caddyfile` to a directory there, then configure:

```bash
export T3_RELAY_DOMAIN=relay.example.com
export T3_RELAY_REGISTRATION_TOKEN="$(openssl rand -hex 32)"
```

Keep the registration token in your private deployment configuration and use
the same value on your hosts. Clients receive pairing links rather than this
token. Load the supplied Docker image, or build it from this checkout:

```bash
vp i
VITE_HOSTED_APP_CHANNEL=latest vp run --filter @t3tools/web build
docker build --target web -f infra/selfhosted-relay/Dockerfile -t t3-selfhosted-relay:latest .
docker build --target core -f infra/selfhosted-relay/Dockerfile -t t3-selfhosted-relay:latest-core .
```

Both images contain the same Rust relay. The core image needs no web build;
the web image adds the static client without source maps. Node and the Rust
compiler are not included in either runtime image. These tags name local
builds, not images published to a registry.

With the image available on the VPS, start the relay and Caddy:

```bash
docker compose --profile tls up -d --no-build
```

To run the core image instead, set
`T3_RELAY_IMAGE=t3-selfhosted-relay:latest-core`. If building with Compose,
also set `T3_RELAY_BUILD_TARGET=core`.

Allow inbound TCP 80 and 443. Caddy obtains a certificate and forwards WebSockets
to the relay. If you already terminate HTTPS with another proxy, omit the `tls`
profile and proxy to `127.0.0.1:8788`, preserving WebSocket upgrades and long
connections.

The relay holds connection state in memory. Restarting it disconnects clients;
the host connector retries automatically and clients can reconnect. Caddy's
certificate volumes persist across restarts.

## Connect an environment

In the forked desktop or web app, open **Settings → Sharing & access**. In the
host card, choose **Self-hosted relay → Set up**, enter the relay origin and
registration token, then choose **Save and connect**. The registration token
is required and must match the relay server; it is not a device pairing code.
The host saves the token privately, keeps its
identity across restarts, and reconnects automatically whenever its T3 server
starts. No separate CLI connector is needed for this mode.

Once connected, use **Authorized clients → Create link**, choose **Self-hosted
relay** as the connection type, and select the device label and permissions.
The same dialog also creates links using an existing direct address. Relay links
are one-use, expire after ten minutes, and cannot grant permissions beyond your
current session. Both types share the authorized-client list and revocation controls.

In the relay configuration dialog's actions menu, use **Disconnect relay** to
stop while retaining configuration, or **Remove relay configuration** to remove
the saved URL and token. Neither action revokes paired clients or changes the
host identity; manage revocations under **Authorized clients** in
**Settings → Sharing & access**. Stopping the host app stops the connector too.

Alternatively, manage a separate connector from the CLI (do not run it at the
same time as the built-in connector for the same identity):

Keep T3 running on the host. Use the CLI built from this fork to connect its
loopback server:

```bash
export T3_RELAY_REGISTRATION_TOKEN='<your registration token>'
t3 relay connect \
  --url https://relay.example.com \
  --target http://127.0.0.1:3773
```

Replace the target port with your running T3 server's actual port. Keep this
connector running, for example under your existing process supervisor. It does
not start T3. Closing the desktop app's last window can stop its bundled
server, so use a separately running T3 service when the environment needs to
stay available.

The connector creates a host identity at `~/.t3/relay/identity.json`. Retain
that file across restarts. For multiple T3 environments on the same machine,
give each connector its own `--identity-file`.

In a second terminal, issue a pairing link:

```bash
t3 relay pair --url https://relay.example.com
```

For a server with a custom T3 home, also pass the matching `--base-dir` to
`relay pair`. Use the same `--identity-file` as the connector. The link expires
after ten minutes and uses the existing T3 one-time pairing mechanism.

Open it to use the relay's web app, or paste the complete link into the
fork's client connection flow. Repeat for other hosts and clients. Store and
share pairing links privately: they grant access to the environment.

The core image does not serve pairing pages. Paste its pairing link into a
forked desktop or mobile client, or the Connections settings of a separately
hosted forked web client. Do not replace the link's domain: it identifies the
relay the client must contact.

Opening the web image's domain without a pairing link shows the unconnected
client, not a public list of registered hosts. Previously paired browsers can
reconnect using their own saved credentials; visitors do not share sessions.

## Trust and compatibility

The host and client establish a Noise encrypted session through the relay.
The pairing link pins the host's public identity. The relay forwards encrypted
traffic and can observe connection addresses, timing and sizes. It does not
need host private keys or T3 session credentials. Verify pairing links through
a channel you trust.

The browser loads its executable app from the web host. That host must be
trusted to serve the intended build; encryption cannot protect a browser from
an operator who replaces the client JavaScript.

Existing T3 bearer sessions and permission checks remain in effect inside the
encrypted channel. Changing the host identity requires pairing again. Rotate
the registration token on the relay and hosts if it is disclosed, and revoke
paired client sessions through T3's existing access controls.

This transport carries T3 HTTP and WebSocket traffic, including streamed
uploads, attachments, and byte-range media requests. Web resource access
requires a service worker and an open T3 page; a copied resource URL is not an
independent public download link. Remote HTML documents are sandboxed. This
mode does not publish arbitrary local development ports or rewrite arbitrary
websites' absolute URLs.

T3 Connect account discovery, guest-link hosting and
cloud webhook delivery still depend on their existing services. This relay
does not replace WebRTC signaling, STUN or TURN infrastructure. Device media
and browser previews that rely on those separate paths need their existing
connectivity. Mobile background execution remains subject to the operating
system's suspension rules.

Web, Electron and native resource handling have separate adapters. Protocol
tests and TypeScript checks alone do not establish complete feature parity;
verify the clients you distribute against your relay.

## Optional iOS push

The Relay can optionally deliver iOS agent notifications and update Live
Activities without T3 Connect. Push is off by default, and enabling it does not
change official Connect notifications. Android notifications still use their
existing service.

An environment already publishing notifications through T3 Connect keeps using
Connect, avoiding duplicate deliveries. Disable its Connect notification
publication before switching that environment to self-hosted push.

You need an APNs signing key (`.p8`), its Key ID, your Apple developer Team ID,
and the Bundle ID of the iOS app you distribute. The app must be signed under
that Apple team with push notifications enabled. An app-signing `.p12` and a
provisioning profile alone are not APNs sending credentials. Unrelated keys
cannot send notifications to the official App Store app.

For Compose deployments, set `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and
`APNS_PRIVATE_KEY_FILE` (the local path to the `.p8`), then apply the optional
override from the Relay directory:

```bash
docker compose -f compose.yaml -f compose.push.yaml up -d
```

Add `--profile tls` if using the supplied Caddy service. The key must be readable
by the Relay's container user (UID 65532); keep its host directory private and
mount it read-only. Use `APNS_ENVIRONMENT=sandbox` for development-signed app
builds, or `production` for distribution builds. Mismatched app identities or
environments are rejected during device registration.

Without Compose, set `T3_RELAY_PUSH_ENABLED=true`, `APNS_TEAM_ID`, `APNS_KEY_ID`,
`APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`, `APNS_PRIVATE_KEY_FILE`, and
`T3_RELAY_PUSH_DATABASE`. The database must be in a persistent writable directory;
its registrations and pending deliveries survive Relay restarts. Restrict access
to this directory: it holds device tokens and notification metadata.

Connect the environment using **Settings > Sharing & access > Self-hosted
relay**, then pair the forked iOS app with its pairing link. The host uses its
existing Relay configuration to publish notification state. A standalone
`t3 relay connect` process does not configure the host's notification service.
On iOS, open **Settings > Notifications > Self-hosted Relay** to grant notification
access or turn off self-hosted notifications and Live Activities independently
of Connect. This requires the forked client that implements this feature;
installing an unchanged official app does not add it.

Like the current Connect implementation, Live Activities are started while the
app is in the foreground, then updated and ended through APNs in the background.
Remote push-to-start is not implemented. Keep the host running to publish task
changes. Delivery is subject to iOS notification permissions, Live Activity
settings, network availability, and Apple's delivery policy; it is not guaranteed.

The optional push service receives agent titles, state, device tokens, and the
environment/session identifiers needed for delivery. Unlike the encrypted
connection transport, this metadata is readable by the Relay operator and Apple.
Use a Relay operator you trust. Removing a paired client on the host revokes its
notification registration as well. Detaching a connection or switching backends
attempts to clean up old registrations. An offline backend cannot confirm cleanup;
do not treat local connection removal as server-side revocation.
Back up the push-data volume and retain the
APNs key; do not include either in a public image.
