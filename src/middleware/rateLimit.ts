import { rateLimit } from 'express-rate-limit';

function limitMessage(message: string) {
  return { ok: false, error: message };
}

export const aiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limitMessage('Limite de requisicoes de IA excedido. Tente novamente em instantes.'),
});

export const portaoRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: limitMessage('Muitas solicitacoes de abertura. Aguarde um minuto.'),
});
