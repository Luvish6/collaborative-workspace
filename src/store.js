import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

export async function openStore({ url, file = "data/workspace.sqlite" } = {}) {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000 });
    pool.on("error", error => console.error("Idle database connection:", error.message));
    try {
      await pool.query("CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, snapshot BYTEA NOT NULL)");
    } catch (error) {
      await pool.end();
      throw error;
    }
    return {
      async create(id, snapshot) {
        await pool.query("INSERT INTO rooms (id, snapshot) VALUES ($1, $2)", [id, Buffer.from(snapshot)]);
      },
      async get(id) {
        const { rows } = await pool.query("SELECT snapshot FROM rooms WHERE id = $1", [id]);
        return rows[0]?.snapshot;
      },
      async save(id, snapshot) {
        await pool.query("UPDATE rooms SET snapshot = $2 WHERE id = $1", [id, Buffer.from(snapshot)]);
      },
      close: () => pool.end()
    };
  }
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, snapshot BLOB NOT NULL)");
  const create = db.prepare("INSERT INTO rooms VALUES (?, ?)");
  const get = db.prepare("SELECT snapshot FROM rooms WHERE id = ?");
  const save = db.prepare("UPDATE rooms SET snapshot = ? WHERE id = ?");
  return {
    create: (id, snapshot) => create.run(id, snapshot),
    get: id => get.get(id)?.snapshot,
    save: (id, snapshot) => save.run(snapshot, id),
    close: () => db.close()
  };
}
