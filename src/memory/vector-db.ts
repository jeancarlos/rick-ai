import { Pool, PoolClient } from "pg";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";

let vectorPool: Pool;

export function getVectorPool(): Pool {
  if (!vectorPool) {
    if (!config.vectorDatabaseUrl) {
      throw new Error("VECTOR_DATABASE_URL is not configured");
    }

    vectorPool = new Pool({
      connectionString: config.vectorDatabaseUrl,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: false,
    });

    vectorPool.on("error", (err) => {
      logger.error({ err }, "Unexpected vector pool error");
    });
  }
  return vectorPool;
}

export async function vectorQuery(text: string, params?: any[]) {
  const client = await getVectorPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function closeVectorPool(): Promise<void> {
  if (vectorPool) {
    await vectorPool.end();
  }
}
