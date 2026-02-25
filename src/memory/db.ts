/**
 * Backward-compatible re-exports from the new database abstraction layer.
 *
 * All existing code that imports from "./db.js" continues to work unchanged.
 * The actual implementation is in database.ts which supports both pg and SQLite.
 */

export { query, closeDatabase as closePool } from "./database.js";

// Re-export transaction with the old pg-compatible signature.
// The old signature was: transaction<T>(fn: (client: PoolClient) => Promise<T>)
// The new signature is: transaction<T>(fn: (queryFn) => Promise<T>)
// Since the old code used client.query(text, params) which returns { rows, rowCount },
// and the new queryFn also returns { rows, rowCount }, the interface is compatible.
export { transaction } from "./database.js";
