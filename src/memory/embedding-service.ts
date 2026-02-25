import { config } from "../config/env.js";

/**
 * Embedding service using Gemini's gemini-embedding-001 model via REST API.
 * Native output is 3072 dimensions, truncated to 768 for pgvector HNSW compatibility.
 * Free tier: 1500 requests/min.
 */
export class EmbeddingService {
  private apiKey: string;
  private modelName = "gemini-embedding-001";
  /** Truncated to 768 for HNSW index compatibility (max 2000 dims in pgvector) */
  static readonly DIMENSIONS = 768;

  constructor() {
    this.apiKey = config.gemini.apiKey;
  }

  /**
   * Generate embedding for a single text via REST API with outputDimensionality.
   */
  async embed(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:embedContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${this.modelName}`,
        content: { parts: [{ text }] },
        outputDimensionality: EmbeddingService.DIMENSIONS,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Embedding API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as { embedding: { values: number[] } };
    return data.embedding.values;
  }

  /**
   * Generate embeddings for multiple texts in batch via REST API.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.embed(texts[0])];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:batchEmbedContents?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.modelName}`,
          content: { parts: [{ text }] },
          outputDimensionality: EmbeddingService.DIMENSIONS,
        })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Batch embedding API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as { embeddings: { values: number[] }[] };
    return data.embeddings.map((e) => e.values);
  }

  /**
   * Format embedding array as pgvector-compatible string: '[0.1,0.2,...]'
   */
  static toPgVector(embedding: number[]): string {
    return `[${embedding.join(",")}]`;
  }
}
