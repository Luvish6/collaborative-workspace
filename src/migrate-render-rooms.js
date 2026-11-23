import { createHash } from "node:crypto";
import pg from "pg";
import * as Y from "yjs";

const ddl = "(id TEXT PRIMARY KEY, snapshot BYTEA NOT NULL)";
const batch = 32;

class MigrationCheck extends Error {
  constructor(message) {
    super(message);
    this.code = message;
  }
}

async function scan(client, table, consume) {
  const hash = createHash("sha256");
  let last = "";
  let count = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT id, snapshot FROM ${table} WHERE id COLLATE "C" > $1 ORDER BY id COLLATE "C" LIMIT $2`,
      [last, batch]
    );
    if (!rows.length) break;
    for (const { id, snapshot } of rows) {
      if (!/^[A-Za-z0-9_-]{24}$/.test(id) || !Buffer.isBuffer(snapshot)) throw new MigrationCheck("Unexpected room data");
      const size = Buffer.alloc(4);
      size.writeUInt32BE(snapshot.length);
      hash.update(id).update(size).update(snapshot);
      if (consume) await consume(id, snapshot);
      last = id;
      count++;
    }
  }
  return { count, digest: hash.digest("hex") };
}

function verify(expected, actual) {
  if (expected.count !== actual.count || expected.digest !== actual.digest) {
    throw new MigrationCheck("Room counts or hashes differ");
  }
}

async function verifySourceSchema(source) {
  const { rows } = await source.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`);
  const expected = [
    { table_name: "rooms", column_name: "id", data_type: "text", is_nullable: "NO" },
    { table_name: "rooms", column_name: "snapshot", data_type: "bytea", is_nullable: "NO" }
  ];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) throw new MigrationCheck("Unexpected source schema");
  const key = await source.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'public.rooms'::regclass`);
  if (key.rows.length !== 1 || key.rows[0].definition !== "PRIMARY KEY (id)") throw new MigrationCheck("Unexpected source constraints");
  const indexes = await source.query(`SELECT count(*)::int AS count FROM pg_index
    WHERE indrelid = 'public.rooms'::regclass`);
  if (indexes.rows[0].count !== 1) throw new MigrationCheck("Unexpected source indexes");
}

export function checkedNeonUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MigrationCheck("NEON_MIGRATION_URL is not a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler")) {
    throw new MigrationCheck("NEON_MIGRATION_URL must be a direct Neon Postgres connection");
  }
  url.searchParams.set("sslmode", "verify-full");
  return url.href;
}

export async function migrateRenderRooms(sourceUrl, targetUrl, phase = "stage") {
  if (!sourceUrl || !targetUrl) throw new MigrationCheck("Both migration connections are required");
  if (phase !== "stage" && phase !== "cutover") throw new MigrationCheck("Invalid migration phase");
  const cutover = phase === "cutover";
  const backup = cutover ? "side_by_side_migration.rooms_backup" : "side_by_side_migration.rooms_stage_backup";
  const from = new URL(sourceUrl);
  const to = new URL(targetUrl);
  if (from.hostname === to.hostname) throw new MigrationCheck("Source and target database hosts must differ");

  const source = new pg.Client({ connectionString: sourceUrl, connectionTimeoutMillis: 15000 });
  const target = new pg.Client({ connectionString: targetUrl, connectionTimeoutMillis: 15000 });
  try {
    await source.connect();
    await target.connect();
    if (!target.connection.stream.encrypted || !target.connection.stream.authorized) {
      throw new MigrationCheck("Neon TLS verification failed");
    }

    await source.query(cutover ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await source.query("SET LOCAL lock_timeout = '12s'");
    // This blocks writes from the previous Render instance until the cutover is decided.
    if (cutover) await source.query("LOCK TABLE public.rooms IN SHARE ROW EXCLUSIVE MODE");
    await verifySourceSchema(source);
    const fence = await source.query(`SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.rooms'::regclass
      AND tgname = 'side_by_side_cutover_fence' AND tgenabled = 'O' AND NOT tgisinternal`);
    if (fence.rowCount) {
      if (!cutover) throw new MigrationCheck("Source already fenced");
      // On a restart after cutover, verify the immutable backup without touching active Neon rows.
      verify(await scan(source, "public.rooms"), await scan(target, "side_by_side_migration.rooms_backup"));
      await source.query("COMMIT");
      return true;
    }

    await target.query("BEGIN");
    const state = await target.query(`SELECT to_regclass('public.rooms') AS rooms,
      to_regclass($1) AS backup, to_regclass('side_by_side_migration.rooms_stage_backup') AS staged`, [backup]);
    if (state.rows[0].rooms) throw new MigrationCheck("Neon target already has a live rooms table");
    if (cutover && !state.rows[0].staged) throw new MigrationCheck("Verified staging copy is required");
    if (state.rows[0].backup) {
      if (cutover) throw new MigrationCheck("Cutover backup already exists");
      const staged = await scan(target, backup);
      console.log("Side by Side stage retained: " + staged.count + " room snapshots");
      return false;
    }
    await target.query("CREATE SCHEMA IF NOT EXISTS side_by_side_migration");
    await target.query("REVOKE ALL ON SCHEMA side_by_side_migration FROM PUBLIC");
    await target.query("CREATE TABLE " + backup + " " + ddl);
    const expected = await scan(source, "public.rooms", async (id, snapshot) => {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, snapshot);
      } finally {
        doc.destroy();
      }
      await target.query("INSERT INTO " + backup + " VALUES ($1, $2)", [id, snapshot]);
    });
    const sourceCount = await source.query("SELECT count(*)::int AS count FROM public.rooms");
    if (sourceCount.rows[0].count !== expected.count) throw new MigrationCheck("Incomplete source scan");
    verify(expected, await scan(target, backup));
    if (!cutover) {
      await target.query("COMMIT");
      await source.query("COMMIT");
      console.log("Side by Side stage verified: " + expected.count + " room snapshots and matching SHA-256");
      return false;
    }
    await target.query("CREATE TABLE public.rooms " + ddl);
    await target.query("INSERT INTO public.rooms SELECT * FROM " + backup);
    verify(expected, await scan(target, "public.rooms"));

    await source.query(`
      CREATE FUNCTION public.side_by_side_cutover_readonly() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Side by Side database cutover'; END; $$;
      CREATE TRIGGER side_by_side_cutover_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON public.rooms FOR EACH STATEMENT EXECUTE FUNCTION public.side_by_side_cutover_readonly()`);
    await target.query("COMMIT");
    await source.query("COMMIT");
    console.log("Side by Side migration verified: " + expected.count + " room snapshots and matching SHA-256");
    return true;
  } finally {
    // Closing either connection rolls back any transaction that did not commit.
    await Promise.allSettled([source.end(), target.end()]);
  }
}
