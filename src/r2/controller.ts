// src/r2/controller.ts
// Handlers HTTP do módulo R2.
// Responsabilidade única: parsear req → chamar service → responder com res.

import multer from 'multer';
import type { Request, Response } from 'express';
import { uploadFile, removeFile, getFileUrl, listFotos } from './service';
import { toObjectId } from './utils';

// Multer em memória — arquivo fica em req.file.buffer
export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single('file');

// ─────────────────────────────────────────
// POST /r2_upload
// ─────────────────────────────────────────

export async function handleUpload(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ ok: false, error: 'campo "file" obrigatório (multipart/form-data)' });
      return;
    }

    const required = ['createdBy', 'originalName', 'collection', 'userId', 'folder', 'resource'];
    const missing = required.filter(f => !req.body[f]);
    if (missing.length) {
      res.status(400).json({ ok: false, error: `campos obrigatórios faltando: ${missing.join(', ')}` });
      return;
    }

    // A autoria vem da identidade validada, nunca de um campo controlado pelo cliente.
    req.body.createdBy = req.auth!.userId;

    const result = await uploadFile({
      fileBuffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalName: req.file.originalname,
      body: req.body,
    });

    res.json({ ok: true, file: result });
  } catch (e: any) {
    console.error('[R2] upload error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────
// GET /r2_files/:id
// ─────────────────────────────────────────

export async function handleGetUrl(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params['id'] || req.query['id'];
    if (!toObjectId(rawId)) {
      res.status(400).json({ ok: false, error: 'id inválido' });
      return;
    }

    const result = await getFileUrl(rawId, { presignTtl: 60 });
    if (!result) {
      res.status(404).json({ ok: false, error: 'não encontrado' });
      return;
    }

    res.json({ ok: true, url: result.url, isPublic: result.isPublic });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────
// DELETE /r2_files/:id  ou  DELETE /r2_delete?id=
// ─────────────────────────────────────────

export async function handleDelete(req: Request, res: Response): Promise<void> {
  try {
    const rawId = req.params['id'] || req.query['id'] || req.body?.id;
    if (!toObjectId(rawId)) {
      res.status(400).json({ ok: false, error: 'id inválido' });
      return;
    }

    const deleted = await removeFile(rawId);
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'não encontrado' });
      return;
    }

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────
// GET /fotos
// ─────────────────────────────────────────

export async function handleListFotos(req: Request, res: Response): Promise<void> {
  try {
    const { type = 'latest', limit = '10', idosoId } = req.query as Record<string, string>;

    if (String(type) === 'byResident' && !idosoId) {
      res.status(400).json({ ok: false, error: 'idosoId é obrigatório quando type=byResident' });
      return;
    }

    const fotos = await listFotos({ type, limit, idosoId });
    res.json({ ok: true, fotos });
  } catch (e: any) {
    console.error('[R2] listFotos error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
