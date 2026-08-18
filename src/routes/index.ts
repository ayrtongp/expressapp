import { Router } from 'express';
import express from 'express';
import type { Application } from 'express';
import * as PortaoController from '../controller/portao.controller';
import { getGroups } from '../api/Whatsapp.js/index';
import { buildSegundaFeiraMensagem } from '../services/SegundaFeiraBomDiaService';
import { buildPendenciasAdmMensagem } from '../services/PendenciasAdmService';
import { buildFeridasAbertasMensagem } from '../services/FeridasAbertasService';
import * as AiController from '../controller/ai.controller';
import r2Routes from '../r2/routes';
import { requireAnyGroup, requireAuth } from '../middleware/auth';
import { aiRateLimit, portaoRateLimit } from '../middleware/rateLimit';

const router = Router();

// ------------------- CLOUDFLARE R2 + MONGODB -------------------
// Rotas definidas em src/r2/routes.ts
router.use(requireAuth, r2Routes);


// ------------------- IA -------------------
router.post('/ai/complete', aiRateLimit, requireAuth, express.json({ limit: '10mb' }), AiController.complete);

// ------------------- WHATSAPP DEBUG -------------------
router.get('/whatsapp/groups', requireAuth, requireAnyGroup('administrativo'), async (_req, res) => {
  try {
    const data = await getGroups();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp/segunda-feira/teste', requireAuth, requireAnyGroup('administrativo'), express.json(), async (req, res) => {
  try {
    const db = req.app.locals['db'];
    const msg = await buildSegundaFeiraMensagem(db);
    const destino = process.env.WPP_GROUP_GRUPAO!;
    await (await import('../api/Whatsapp.js/index')).sendMessage(destino, msg);
    res.json({ ok: true, destino, preview: msg });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp/feridas/teste', requireAuth, requireAnyGroup('administrativo'), express.json(), async (req, res) => {
  try {
    const db = req.app.locals['db'];
    const msg = await buildFeridasAbertasMensagem(db);
    const destino = process.env.WPP_GROUP_TECNICOS!;
    await (await import('../api/Whatsapp.js/index')).sendMessage(destino, msg);
    res.json({ ok: true, destino, preview: msg });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp/pendencias-adm/teste', requireAuth, requireAnyGroup('administrativo'), express.json(), async (req, res) => {
  try {
    const db = req.app.locals['db'];
    const msg = await buildPendenciasAdmMensagem(db);
    const destino = process.env.WPP_GROUP_ADM!;
    await (await import('../api/Whatsapp.js/index')).sendMessage(destino, msg);
    res.json({ ok: true, destino, preview: msg });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- PORTÃO ESP8266 -------------------
router.post('/portao/abrir', portaoRateLimit, requireAuth, requireAnyGroup('portao_lar'), PortaoController.abrir);
router.get('/portao/logs', requireAuth, requireAnyGroup('administrativo'), PortaoController.logs);
router.get('/portao/health/mqtt/live', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttHealthLiveness);
router.get('/portao/health/mqtt/ready', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttHealthReadiness);
router.get('/portao/health/mqtt', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttHealthReadiness);
router.get('/portao/debug/mqtt/status', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttDebugStatus);
router.get('/portao/debug/mqtt/events', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttDebugEvents);
router.post('/portao/debug/mqtt/publish', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttDebugPublish);
router.post('/portao/debug/mqtt/wait-message', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttDebugWaitMessage);
router.post('/portao/debug/mqtt/wait-ack', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttDebugWaitAck);
router.post('/portao/debug/mqtt/press', requireAuth, requireAnyGroup('administrativo'), PortaoController.mqttDebugPress);

export default (app: Application): void => { app.use(router); };

