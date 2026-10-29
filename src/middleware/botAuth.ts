import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
export const requireBotToken: RequestHandler = (req, res, next) => {
  const expected = process.env.BOT_SERVICE_TOKEN?.trim() ?? '';
  const supplied = req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1]?.trim() ?? '';
  const valid = expected.length > 0 && supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!supplied) return res.status(401).json({ ok: false, error: 'Autenticacao necessaria.' });
  if (!valid) return res.status(403).json({ ok: false, error: 'Token invalido.' });
  next();
};
