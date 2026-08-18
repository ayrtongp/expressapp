import { Router } from 'express';
import multer from 'multer';
import express from 'express';
import type { Application } from 'express';
import * as PortaoController from '../controller/portao.controller';
import { getGroups } from '../api/Whatsapp.js/index';
import { buildSegundaFeiraMensagem } from '../services/SegundaFeiraBomDiaService';
import { buildPendenciasAdmMensagem } from '../services/PendenciasAdmService';
import { buildFeridasAbertasMensagem } from '../services/FeridasAbertasService';
import * as AiController from '../controller/ai.controller';
import r2Routes from '../r2/routes';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ------------------- CLOUDFLARE R2 + MONGODB -------------------
// Rotas definidas em src/r2/routes.ts
router.use(r2Routes);


// ------------------- IA -------------------
router.post('/ai/complete', express.json({ limit: '10mb' }), AiController.complete);

// ------------------- WHATSAPP DEBUG -------------------
router.get('/whatsapp/groups', async (_req, res) => {
  try {
    const data = await getGroups();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp/segunda-feira/teste', express.json(), async (req, res) => {
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

router.post('/whatsapp/feridas/teste', express.json(), async (req, res) => {
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

router.post('/whatsapp/pendencias-adm/teste', express.json(), async (req, res) => {
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
router.post('/portao/abrir', PortaoController.abrir);   // body: { userId, ms? }
router.get('/portao/logs', PortaoController.logs);      // query: deviceId, limit
router.get('/portao/health/mqtt/live', PortaoController.mqttHealthLiveness);
router.get('/portao/health/mqtt/ready', PortaoController.mqttHealthReadiness);
router.get('/portao/health/mqtt', PortaoController.mqttHealthReadiness);
router.get('/portao/debug/mqtt/status', PortaoController.mqttDebugStatus);
router.get('/portao/debug/mqtt/events', PortaoController.mqttDebugEvents);
router.post('/portao/debug/mqtt/publish', PortaoController.mqttDebugPublish);
router.post('/portao/debug/mqtt/wait-message', PortaoController.mqttDebugWaitMessage);
router.post('/portao/debug/mqtt/wait-ack', PortaoController.mqttDebugWaitAck);
router.post('/portao/debug/mqtt/press', PortaoController.mqttDebugPress);

export default (app: Application): void => { app.use(router); };

