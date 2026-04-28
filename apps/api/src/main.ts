import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './shared/infrastructure/socket/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: process.env.NODE_ENV !== 'production',
    }),
  );

  // Security: Helmet headers
  await app.register(helmet as any, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
  });

  // Security: CORS with explicit origins
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:5173', // Vite dev server (React Router v7)
      'http://localhost:3000', // Alternative dev port
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
      'X-Signature',
      'X-Timestamp',
      'X-Terminal-ID',
    ],
    credentials: true,
  });

  // Security: Global validation — strip AND reject unknown properties
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      disableErrorMessages: process.env.NODE_ENV === 'production',
    }),
  );

  // Socket.io Redis adapter (multi-instance broadcast)
  const redisAdapter = new RedisIoAdapter(app);
  await redisAdapter.connectToRedis();
  app.useWebSocketAdapter(redisAdapter);

  // Graceful shutdown
  app.enableShutdownHooks();

  const port = process.env.API_PORT || 3001;
  const host = process.env.API_HOST || '0.0.0.0';

  await app.listen(port, host);
  console.log(`API running on http://${host}:${port}`);
}

bootstrap();
