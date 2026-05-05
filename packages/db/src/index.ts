import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// Schema exports
export * from './schemas/auth';
export * from './schemas/pos';
export * from './schemas/accounting';
export * from './schemas/audit';
export * from './schemas/rag';
export * from './schemas/organization';
export * from './schemas/inventory';
export * from './schemas/purchasing';
export * from './schemas/sales';
export * from './schemas/bank-rec';
export * from './schemas/fixed-assets';
export * from './schemas/cit';
export * from './schemas/approvals';

// Database client factory
export function createDb(connectionString?: string) {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL required (copy .env.example to .env and configure)');
  }
  const client = postgres(url);
  return drizzle(client);
}

export type Database = ReturnType<typeof createDb>;
