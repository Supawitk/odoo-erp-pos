import { uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';
import { customSchema } from './auth';

// RAG resources (products, policies, FAQs)
export const ragResources = customSchema.table('rag_resources', {
  id: uuid('id').primaryKey().defaultRandom(),
  content: text('content').notNull(),
  type: text('type').notNull(), // product, policy, faq, invoice
  sourceModel: text('source_model'), // product.product, account.move
  sourceId: text('source_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Embeddings for vector similarity search
export const ragEmbeddings = customSchema.table(
  'rag_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id').references(() => ragResources.id, {
      onDelete: 'cascade',
    }),
    chunk: text('chunk').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (table) => ({
    embeddingIdx: index('embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  }),
);
