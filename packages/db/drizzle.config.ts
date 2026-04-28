import { defineConfig } from 'drizzle-kit';

const required = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} required for drizzle-kit (copy .env.example to .env)`);
  return v;
};

export default defineConfig({
  schema: './src/schemas/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT) || 5432,
    // Migrations run as the superuser so they can CREATE EXTENSION / SCHEMA / ROLE.
    user: process.env.POSTGRES_SUPERUSER || required('POSTGRES_SUPERUSER'),
    password: process.env.POSTGRES_SUPERUSER_PASSWORD || required('POSTGRES_SUPERUSER_PASSWORD'),
    database: process.env.POSTGRES_DB || 'odoo',
    ssl: false,
  },
});
