import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { ObjectId, type Db } from 'mongodb';

type PortalToken = JwtPayload & {
  userId?: string | ObjectId;
};

function unauthorized(res: Response): void {
  res.status(401).json({ ok: false, error: 'Autenticacao necessaria.' });
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;

  const token = header.slice(7).trim();
  return token || null;
}

async function getGroupCodes(db: Db, userId: string): Promise<string[]> {
  const userObjectId = new ObjectId(userId);
  const relations = await db
    .collection('grupos_usuario')
    .find({ id_usuario: { $in: [userId, userObjectId] } })
    .project({ id_grupo: 1 })
    .toArray();

  const groupIds = Array.from(
    new Set(
      relations
        .map(relation => String(relation.id_grupo ?? ''))
        .filter(id => ObjectId.isValid(id)),
    ),
  ).map(id => new ObjectId(id));

  if (groupIds.length === 0) return [];

  const groups = await db
    .collection('grupos')
    .find({ _id: { $in: groupIds } })
    .project({ cod_grupo: 1 })
    .toArray();

  return groups
    .map(group => String(group.cod_grupo ?? '').trim().toLowerCase())
    .filter(Boolean);
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = getBearerToken(req);
  const secret = process.env.JWT_SECRET?.trim();

  if (!token || !secret) {
    unauthorized(res);
    return;
  }

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
    }) as PortalToken;
    const userId = String(decoded.userId ?? '');

    if (!ObjectId.isValid(userId)) {
      unauthorized(res);
      return;
    }

    const db = req.app.locals['db'] as Db | undefined;
    if (!db) {
      next(new Error('MongoDB nao inicializado.'));
      return;
    }

    const user = await db.collection('usuario').findOne(
      { _id: new ObjectId(userId) },
      { projection: { ativo: 1 } },
    );

    if (!user || (user.ativo !== 'S' && user.ativo !== true)) {
      unauthorized(res);
      return;
    }

    req.auth = {
      userId,
      groups: await getGroupCodes(db, userId),
    };
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      unauthorized(res);
      return;
    }
    next(error);
  }
};

export function requireAnyGroup(...allowedGroups: string[]): RequestHandler {
  const allowed = new Set(allowedGroups.map(group => group.trim().toLowerCase()));

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      unauthorized(res);
      return;
    }

    if (!req.auth.groups.some(group => allowed.has(group))) {
      res.status(403).json({ ok: false, error: 'Permissao insuficiente.' });
      return;
    }

    next();
  };
}
