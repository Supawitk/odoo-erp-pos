import { Module, Global } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error(
            'DATABASE_URL is required. Copy .env.example to .env and fill in your local Postgres credentials.',
          );
        }
        const client = postgres(connectionString, {
          max: 20,
          idle_timeout: 30,
          connect_timeout: 10,
        });
        return drizzle(client);
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
