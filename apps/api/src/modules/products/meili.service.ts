import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
// meilisearch 0.57 is ESM-only with exports map; apps/api is CJS/node
// resolution, so we dynamic-import at runtime and type opaquely.
type Index = {
  updateSettings(settings: unknown): Promise<unknown>;
  addDocuments(docs: unknown[]): Promise<unknown>;
  search(q: string, opts: unknown): Promise<{ hits: unknown[] }>;
  deleteAllDocuments(): Promise<unknown>;
};
type MeiliSearchClient = {
  health(): Promise<unknown>;
  index(name: string): Index;
};

/**
 * Meilisearch-backed product search for the iPad POS.
 *
 * pg_trgm handles prefix/fuzzy matches on one column; Meilisearch gives us
 * multi-field search (name + sku + category + barcode), typo tolerance across
 * Thai + English, and sub-50ms latency at scale.
 *
 * Fails open: if Meilisearch is unreachable the service reports unavailable;
 * the ProductsController falls back to pg_trgm.
 */
@Injectable()
export class MeiliService implements OnModuleInit {
  private readonly logger = new Logger(MeiliService.name);
  private client: MeiliSearchClient | null = null;
  private index: Index | null = null;
  private available = false;

  async onModuleInit() {
    try {
      // Meilisearch 0.57 ships exports-only ESM; node CJS moduleResolution
      // can't see its types. Runtime require works fine — drop types here.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('meilisearch') as {
        // meilisearch 0.57 renamed the class from `MeiliSearch` (camel-S) to
        // `Meilisearch` (lower-s). Keep both as a defensive fallback in case
        // the package flips back.
        Meilisearch?: new (cfg: { host: string; apiKey?: string }) => MeiliSearchClient;
        MeiliSearch?: new (cfg: { host: string; apiKey?: string }) => MeiliSearchClient;
      };
      const Ctor = mod.Meilisearch ?? mod.MeiliSearch;
      if (!Ctor) throw new Error('meilisearch package missing Meilisearch class');
      this.client = new Ctor({
        host: process.env.MEILISEARCH_URL ?? 'http://localhost:7700',
        apiKey: process.env.MEILISEARCH_KEY ?? 'master_key',
      });
      await this.client.health();
      this.index = this.client.index('products');
      await this.index.updateSettings({
        searchableAttributes: ['name', 'sku', 'barcode', 'category'],
        filterableAttributes: ['category', 'isActive'],
        typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 3, twoTypos: 5 } },
      });
      this.available = true;
      this.logger.log('Meilisearch connected; products index ready');
    } catch (err: any) {
      this.logger.warn(`Meilisearch unavailable: ${err?.message ?? err}. Falling back to pg_trgm.`);
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  async upsert(
    docs: Array<{
      id: string;
      name: string;
      sku: string | null;
      barcode: string | null;
      category: string | null;
      priceCents: number;
      isActive: boolean;
    }>,
  ) {
    if (!this.index) return;
    await this.index.addDocuments(docs);
  }

  async search(q: string, opts: { limit?: number } = {}) {
    if (!this.index) throw new Error('Meilisearch not available');
    const res = await this.index.search(q, { limit: opts.limit ?? 20, filter: ['isActive = true'] });
    return (res.hits ?? []) as Array<{
      id: string;
      name: string;
      sku: string | null;
      barcode: string | null;
      category: string | null;
      priceCents: number;
    }>;
  }

  async deleteAll() {
    if (!this.index) return;
    await this.index.deleteAllDocuments();
  }
}
