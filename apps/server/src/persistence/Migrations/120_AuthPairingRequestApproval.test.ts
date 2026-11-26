import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "120_AuthPairingRequestApproval",
  (it) => {
    it.effect(
      "backfills only historical grants and sessions with an unambiguous Relay subject",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 119 });
          for (const subject of ["self-hosted-relay-group", "one-time-token", "cloud-connect"]) {
            yield* sql`
          INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at)
          VALUES (${subject}, ${subject}, 'one-time-token', '[]', ${subject},
            '2026-11-27T00:00:00.000Z', '2026-11-27T00:10:00.000Z')
        `;
            yield* sql`
          INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
          VALUES (${subject}, ${subject}, '[]', 'dpop-access-token',
            '2026-11-27T00:00:00.000Z', '2026-11-27T01:00:00.000Z')
        `;
          }
          yield* runMigrations();
          for (const table of ["auth_pairing_links", "auth_sessions"]) {
            expect(
              yield* sql`
          SELECT subject, authorization_source FROM ${sql(table)} ORDER BY subject
        `,
            ).toEqual([
              { subject: "cloud-connect", authorization_source: null },
              { subject: "one-time-token", authorization_source: null },
              { subject: "self-hosted-relay-group", authorization_source: "relay-auto" },
            ]);
          }
          expect(yield* sql`SELECT approved_at FROM auth_pairing_links`).toEqual([
            { approved_at: null },
            { approved_at: null },
            { approved_at: null },
          ]);
        }),
    );
  },
);
