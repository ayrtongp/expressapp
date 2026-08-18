import type { Request, Response } from 'express';
import {
  abrirPortao,
  waitForAck,
  client,
  TOPIC_CMD,
  TOPIC_STAT,
  getMqttDebugSnapshot,
  getRecentMqttDebugEvents,
  publishDebugMessage,
  waitForNextMessage,
} from '../services/mqtt';
import { getDb } from '../config/mongoDB';
import { sendMessage } from '../api/Whatsapp.js';
import { getUserName } from './mongo.controller';

function getLocalHour(tz: string): number {
  const s = new Date().toLocaleString('pt-BR', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return Number(s);
}

function isHorarioBloqueado(tz: string, inicio: number, fim: number): boolean {
  const h = getLocalHour(tz);
  if (inicio < fim) return h >= inicio && h < fim;
  return h >= inicio || h < fim;
}

function getLocalTimeStr(tz: string): string {
  return new Date().toLocaleString('pt-BR', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseQos(value: unknown, fallback: 0 | 1 | 2 = 1): 0 | 1 | 2 {
  const n = Number(value);
  if (n === 0 || n === 1 || n === 2) return n;
  return fallback;
}

const MQTT_REQUIRED_ENV = ['MQTT_HOST', 'MQTT_PORT', 'MQTT_USER', 'MQTT_PASS', 'MQTT_DEVICE_ID', 'MQTT_TOPIC_BASE'] as const;

function getMqttHealthState() {
  const enabled = process.env.ENABLE_PORTAO_MQTT === 'true';
  const missingEnv = MQTT_REQUIRED_ENV.filter((name) => !process.env[name] || String(process.env[name]).trim() === '');
  const debug = getMqttDebugSnapshot();
  const ready = enabled && missingEnv.length === 0 && client.connected;

  const reasons: string[] = [];
  if (!enabled) reasons.push('mqtt_disabled');
  if (missingEnv.length > 0) reasons.push('missing_env');
  if (!client.connected) reasons.push('client_not_connected');

  return {
    enabled,
    ready,
    reasons,
    missingEnv,
    connected: client.connected,
    disconnected: client.disconnected,
    reconnecting: debug.reconnecting,
    topics: { cmd: TOPIC_CMD, stat: TOPIC_STAT },
    debug,
  };
}

export async function abrir(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.auth?.userId;
    const { ms = 300 } = req.body as { ms?: number };
    if (!userId) {
      res.status(401).json({ ok: false, error: 'Autenticacao necessaria.' });
      return;
    }

    const db = getDb();
    const logs = db.collection('logs_portao');
    const deviceId = process.env.MQTT_DEVICE_ID || 'portao01';

    const TZ = process.env.PORTAO_TZ || process.env.TZ || 'America/Sao_Paulo';
    const BLOQ_INICIO = Number(process.env.PORTAO_BLOQUEIO_INICIO ?? 22);
    const BLOQ_FIM = Number(process.env.PORTAO_BLOQUEIO_FIM ?? 6);
    const horaAtual = getLocalTimeStr(TZ);
    const bloqueado = isHorarioBloqueado(TZ, BLOQ_INICIO, BLOQ_FIM);

    let userName = String(userId);
    try { userName = await getUserName(userId); } catch (_) { }

    const requestedMs = Math.min(Math.max(Number(ms) || 300, 100), 5000);
    const now = new Date();

    if (bloqueado) {
      await logs.insertOne({
        userId: String(userId), userName, deviceId,
        status: 'blocked_time', requestedMs, requestedAt: now,
        tz: TZ, hour: horaAtual, window: { start: BLOQ_INICIO, end: BLOQ_FIM },
      });

      try {
        await sendMessage(
          process.env.WPP_CELLAR!,
          `🚫 Tentativa de abertura **fora do horário** (janela ${BLOQ_INICIO}h–${BLOQ_FIM}h).\n👤 Usuário: *${userName}*\n🕒 ${horaAtual}`
        );
      } catch (e: any) {
        console.error('[WPP] falha ao enviar aviso:', e?.message);
      }

      res.status(403).json({
        ok: false,
        error: 'bloqueado_horario',
        detail: `Abertura não permitida entre ${BLOQ_INICIO}h e ${BLOQ_FIM}h (${TZ}).`,
      });
      return;
    }

    const ins = await logs.insertOne({
      userId: String(userId), userName, deviceId,
      status: 'sent', requestedMs, requestedAt: now,
      used: false, tz: TZ, hour: horaAtual,
    });
    const corrId = ins.insertedId?.toString();

    try {
      await sendMessage(process.env.WPP_CELLAR!, `🔔 *${userName}* solicitou abertura.\n📤 Comando enviado ao portão (ms=${requestedMs}).\n⏳ Aguardando confirmação...`);
    } catch (e: any) {
      console.error('[WPP] falha ao enviar aviso inicial:', e?.message);
    }

    const sent = await abrirPortao(requestedMs);
    const timeoutMs = Number(process.env.PORTAO_ACK_TIMEOUT_MS) || 5000;

    try {
      const ackEvt = await waitForAck({ deviceId, sinceDate: now, timeoutMs });

      try {
        await sendMessage(process.env.WPP_CELLAR!, `🔔 Portão aberto por *${userName}*.\n🕒 ${getLocalTimeStr(TZ)}`);
      } catch (e: any) {
        console.error('[WPP] falha ao enviar confirmação:', e?.message);
      }

      res.json({
        ok: true, sent,
        ack: { status: ackEvt.data?.status, ts: ackEvt.data?.ts || null, info: ackEvt.data?.info || null },
        correlationId: corrId,
      });
    } catch {
      try {
        await sendMessage(process.env.WPP_CELLAR!, `❌ Sem confirmação do dispositivo em ${timeoutMs} ms.\n🔎 Verifique energia/Wi-Fi do ESP.`);
      } catch (e: any) {
        console.error('[WPP] falha ao enviar falha:', e?.message);
      }

      res.status(504).json({
        ok: false, error: 'no_ack',
        detail: 'Comando publicado no broker, mas o dispositivo não confirmou a execução dentro do prazo.',
        sent, correlationId: corrId,
      });
    }
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'publish_failed', detail: e.message });
  }
}

export async function logs(req: Request, res: Response): Promise<void> {
  try {
    const db = getDb();
    const col = db.collection('logs_portao');
    const { deviceId = 'portao01', limit = '50' } = req.query as Record<string, string>;

    const docs = await col
      .find({ deviceId })
      .sort({ receivedAt: -1 })
      .limit(Math.min(Number(limit), 500))
      .toArray();

    res.json(docs);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'db_failed', detail: e?.message });
  }
}

export function mqttHealthLiveness(_req: Request, res: Response): void {
  try {
    const health = getMqttHealthState();
    res.json({
      ok: true,
      service: 'mqtt',
      check: 'liveness',
      at: new Date().toISOString(),
      enabled: health.enabled,
      connected: health.connected,
      disconnected: health.disconnected,
      reconnecting: health.reconnecting,
      topics: health.topics,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'mqtt_liveness_failed', detail: e?.message });
  }
}

export function mqttHealthReadiness(_req: Request, res: Response): void {
  try {
    const health = getMqttHealthState();
    const code = health.ready ? 200 : 503;

    res.status(code).json({
      ok: health.ready,
      service: 'mqtt',
      check: 'readiness',
      at: new Date().toISOString(),
      enabled: health.enabled,
      connected: health.connected,
      disconnected: health.disconnected,
      reconnecting: health.reconnecting,
      reasons: health.reasons,
      config: {
        missingEnv: health.missingEnv,
      },
      topics: health.topics,
      debug: {
        counters: health.debug.counters,
        last: health.debug.last,
      },
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'mqtt_readiness_failed', detail: e?.message });
  }
}

export function mqttDebugStatus(_req: Request, res: Response): void {
  try {
    const health = getMqttHealthState();

    res.json({
      ok: true,
      enabled: health.enabled,
      connected: health.connected,
      disconnected: health.disconnected,
      reconnecting: health.reconnecting,
      topics: health.topics,
      config: {
        hostSet: Boolean(process.env.MQTT_HOST),
        portSet: Boolean(process.env.MQTT_PORT),
        userSet: Boolean(process.env.MQTT_USER),
        passSet: Boolean(process.env.MQTT_PASS),
        deviceId: process.env.MQTT_DEVICE_ID || null,
        topicBase: process.env.MQTT_TOPIC_BASE || null,
        missingEnv: health.missingEnv,
      },
      health: {
        ready: health.ready,
        reasons: health.reasons,
      },
      debug: health.debug,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'mqtt_debug_status_failed', detail: e?.message });
  }
}

export function mqttDebugEvents(req: Request, res: Response): void {
  try {
    const qLimit = Number((req.query.limit as string) || 50);
    const limit = Math.min(Math.max(Number.isFinite(qLimit) ? qLimit : 50, 1), 200);
    res.json({
      ok: true,
      limit,
      events: getRecentMqttDebugEvents(limit),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'mqtt_debug_events_failed', detail: e?.message });
  }
}

export async function mqttDebugPublish(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as {
      topic?: string;
      payload?: unknown;
      qos?: number;
      retain?: boolean | string;
    };

    const topic = typeof body.topic === 'string' && body.topic.trim() ? body.topic.trim() : TOPIC_CMD;
    const payload = body.payload ?? { action: 'press', ms: 300 };
    const qos = parseQos(body.qos, 1);
    const retain = parseBool(body.retain, false);

    const result = await publishDebugMessage({ topic, payload, qos, retain });
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'mqtt_publish_failed', detail: e?.message });
  }
}

export async function mqttDebugWaitMessage(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as {
      topic?: string;
      timeoutMs?: number;
      qos?: number;
    };

    const topic = typeof body.topic === 'string' && body.topic.trim() ? body.topic.trim() : TOPIC_STAT;
    const timeoutInput = Number(body.timeoutMs);
    const timeoutMs = Math.min(Math.max(Number.isFinite(timeoutInput) ? timeoutInput : 15000, 100), 60000);
    const qos = parseQos(body.qos, 1);

    const message = await waitForNextMessage({ topic, timeoutMs, qos });
    res.json({ ok: true, topic, timeoutMs, message });
  } catch (e: any) {
    if (e?.message === 'timeout_waiting_message') {
      res.status(504).json({
        ok: false,
        error: 'timeout_waiting_message',
        detail: 'Nenhuma mensagem recebida no topico dentro do timeout.',
      });
      return;
    }

    res.status(500).json({ ok: false, error: 'mqtt_wait_message_failed', detail: e?.message });
  }
}

export async function mqttDebugWaitAck(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as {
      deviceId?: string;
      timeoutMs?: number;
    };

    const deviceId =
      typeof body.deviceId === 'string' && body.deviceId.trim()
        ? body.deviceId.trim()
        : process.env.MQTT_DEVICE_ID || 'portao01';

    const timeoutInput = Number(body.timeoutMs);
    const timeoutMs = Math.min(Math.max(Number.isFinite(timeoutInput) ? timeoutInput : 10000, 100), 60000);
    const sinceDate = new Date();

    const ackEvt = await waitForAck({ deviceId, sinceDate, timeoutMs });
    res.json({
      ok: true,
      ack: {
        status: ackEvt.data?.status,
        ts: ackEvt.data?.ts || null,
        info: ackEvt.data?.info || null,
      },
      event: {
        topic: ackEvt.topic,
        deviceId: ackEvt.deviceId,
        receivedAt: ackEvt.receivedAt,
      },
    });
  } catch (e: any) {
    if (e?.message === 'no_ack') {
      res.status(504).json({ ok: false, error: 'no_ack', detail: 'Nenhum ack recebido dentro do timeout.' });
      return;
    }

    res.status(500).json({ ok: false, error: 'mqtt_wait_ack_failed', detail: e?.message });
  }
}

export async function mqttDebugPress(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as {
      ms?: number;
      waitAck?: boolean | string;
      timeoutMs?: number;
      deviceId?: string;
    };

    const msInput = Number(body.ms);
    const ms = Math.min(Math.max(Number.isFinite(msInput) ? msInput : 300, 100), 5000);
    const waitAck = parseBool(body.waitAck, true);

    const startedAt = new Date();
    const sent = await abrirPortao(ms);

    if (!waitAck) {
      res.json({ ok: true, sent, ack: null });
      return;
    }

    const deviceId =
      typeof body.deviceId === 'string' && body.deviceId.trim()
        ? body.deviceId.trim()
        : process.env.MQTT_DEVICE_ID || 'portao01';

    const timeoutInput = Number(body.timeoutMs);
    const timeoutMs = Math.min(Math.max(Number.isFinite(timeoutInput) ? timeoutInput : 10000, 100), 60000);

    try {
      const ackEvt = await waitForAck({ deviceId, sinceDate: startedAt, timeoutMs });
      res.json({
        ok: true,
        sent,
        ack: {
          status: ackEvt.data?.status,
          ts: ackEvt.data?.ts || null,
          info: ackEvt.data?.info || null,
          topic: ackEvt.topic,
          receivedAt: ackEvt.receivedAt,
        },
      });
    } catch (ackErr: any) {
      if (ackErr?.message === 'no_ack') {
        res.status(504).json({
          ok: false,
          error: 'no_ack',
          detail: 'Comando publicado, mas sem confirmacao dentro do timeout.',
          sent,
        });
        return;
      }

      throw ackErr;
    }
  } catch (e: any) {
    res.status(500).json({ ok: false, error: 'mqtt_debug_press_failed', detail: e?.message });
  }
}
