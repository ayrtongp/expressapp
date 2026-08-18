import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import type { Application, ErrorRequestHandler } from 'express';
import cronJobs from './src/cronJobs';
import initRoutes from './src/routes';
import { connect } from './src/config/mongoDB';

async function bootstrap(): Promise<void> {
  if (!process.env.JWT_SECRET?.trim()) {
    throw new Error('JWT_SECRET obrigatorio para iniciar a API.');
  }

  const db = await connect();

  const app: Application = express();

  // Somente o Caddy local e os proxies gerenciados podem definir o IP do cliente.
  app.set('trust proxy', 'loopback');

  const WHITELIST = [
    'https://www.larfelizidade.com.br',
    'https://larfelizidade.com.br',
    'http://localhost:3000',
  ];

  const corsOptions: cors.CorsOptionsDelegate = (req, cb) => {
    const origin = req.headers.origin;
    const isAllowed = !!origin && WHITELIST.includes(origin);
    cb(null, {
      origin: isAllowed ? origin : false,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      exposedHeaders: ['Content-Length', 'Content-Type'],
    });
  };

  app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  app.locals['db'] = db;

  // O processo só começa a escutar depois que a conexão com o banco é validada.
  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'lar-felizidade-api' });
  });

  initRoutes(app);

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    console.error('[http] erro nao tratado:', error);
    res.status(500).json({ ok: false, error: 'Erro interno.' });
  };
  app.use(errorHandler);

  if (process.env.ENABLE_PORTAO_MQTT === 'true') {
    require('./src/services/mqtt');
  }

  // Durante a migração, mantenha false para não duplicar tarefas do App Platform.
  if (process.env.ENABLE_CRON === 'true') {
    try {
      cronJobs(app);
    } catch (err) {
      console.error('❌ Erro ao configurar cronJobs:', err);
    }
  } else {
    console.log('⏸️ Cron jobs desabilitados por ENABLE_CRON=false');
  }

  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`🚀 Server rodando em http://localhost:${port}`);
  });
}

bootstrap().catch(err => {
  console.error('❌ Erro ao iniciar a aplicação:', err);
  process.exit(1);
});

