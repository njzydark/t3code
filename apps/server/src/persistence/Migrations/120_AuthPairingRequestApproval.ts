import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN approved_at TEXT`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN authorization_source TEXT`;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN authorization_source TEXT`;
  for (const table of ["auth_pairing_links", "auth_sessions"]) {
    yield* sql`
      UPDATE ${sql(table)} SET authorization_source = 'relay-auto'
      WHERE subject = 'self-hosted-relay-group'
    `;
  }
});
