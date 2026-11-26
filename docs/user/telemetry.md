# Diagnostics and telemetry in this fork

This fork disables telemetry uploads in the CLI, desktop, web, and mobile apps.
The rule is part of the application: environment variables, saved preferences,
managed policies, and configured receiver credentials cannot turn uploads on.
It applies to new builds; an already installed older version keeps its previous
behavior until updated.

## Product usage events

Product usage events are not queued or sent. The server does not create an
analytics install ID, and clients do not send analytics account or device IDs.
Client names and device information used to identify **Authorized clients** remain
part of normal access management.

## Disable telemetry

No setup is needed in this fork. Mobile crash reporting is excluded from the
native app, and the app does not register its JavaScript crash handler. Connection
traces stay off even when an older installation saved an enabled preference.

## Relay connection diagnostics

Relay connection traces are not exported. Local connection logs remain available
for troubleshooting your own environments.

## Agent feedback

Agent feedback uploads are disabled, including automatic reports and reports
requested through an agent or the CLI. Existing feedback approval cards cannot
send a report after updating to this fork.

## Agent activity for mobile notifications

**Publish agent activity**, mobile notifications, and live activities are separate
features that continue to work when configured. They send the information needed
for those features to the selected notification service.

## Export diagnostics to your own OpenTelemetry receiver

External OTLP exports of traces, metrics, and logs are disabled, including exports
to a receiver you configured yourself. Old endpoint settings are ignored.

Local logs, trace files, crash details logged locally, and CPU/memory diagnostics
remain available under **Settings → Maintenance → Diagnostics** and `t3 trace`.
These controls apply to T3 Code itself; provider CLIs and other applications have
their own telemetry settings.
