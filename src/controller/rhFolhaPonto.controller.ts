import type { Request, Response } from 'express';
import archiver from 'archiver';
import { ObjectId } from 'mongodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { s3 } from '../r2/client';

const MESES_EXTENSO = [
  'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    const parts: any[] = [];
    stream.on('data', (chunk: any) => parts.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(parts.map((p: any) => Buffer.from(p)) as any)));
    stream.on('error', reject);
  });
}

function sanitize(name: string): string {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.\-]+/g, '_')
    .trim() || 'arquivo';
}

export async function downloadFolhaPontoZip(req: Request, res: Response): Promise<void> {
  const db = req.app.locals['db'];
  const mes = Number(req.query.mes);
  const ano = Number(req.query.ano);

  if (!mes || !ano) {
    res.status(400).json({ error: 'mes e ano são obrigatórios' });
    return;
  }

  const periodDocs = await db.collection('rh_documentos_periodo')
    .find({ tipo: 'folha_ponto', 'periodo.mes': mes, 'periodo.ano': ano })
    .toArray();

  if (periodDocs.length === 0) {
    res.status(404).json({ error: 'Nenhuma folha de ponto encontrada para este período' });
    return;
  }

  // Monta mapa de r2FileId → metadados do arquivo no arquivosr2
  const r2Ids = periodDocs
    .map((d: any) => d.r2FileId || d.cloudFilename)
    .filter(Boolean);

  const objectIds = r2Ids
    .map((id: string) => { try { return new ObjectId(id); } catch { return null; } })
    .filter(Boolean);

  const r2Records = await db.collection('arquivosr2')
    .find({ _id: { $in: objectIds } })
    .toArray();

  const r2Map = new Map<string, any>(r2Records.map((r: any) => [r._id.toString(), r]));

  const periodo = `${MESES_EXTENSO[mes - 1]}_${ano}`;
  const zipFilename = `folhas-ponto-${periodo}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  for (const doc of periodDocs) {
    const r2Id = (doc as any).r2FileId || (doc as any).cloudFilename;
    if (!r2Id) continue;

    const r2Record = r2Map.get(r2Id);
    if (!r2Record) continue;

    try {
      const cmd = new GetObjectCommand({ Bucket: r2Record.bucket, Key: r2Record.key });
      const result = await s3.send(cmd);
      const buffer = await streamToBuffer(result.Body as Readable);

      const ext = (r2Record.originalName ?? 'pdf').split('.').pop() ?? 'pdf';
      const nomeFuncionario = sanitize((doc as any).funcionarioNome || 'funcionario');
      const filename = `${nomeFuncionario}_${String(mes).padStart(2, '0')}_${ano}.${ext}`;

      archive.append(buffer, { name: filename });
    } catch (err) {
      console.error(`[ZIP] Erro ao obter arquivo de ${(doc as any).funcionarioNome}:`, err);
      // continua para o próximo
    }
  }

  await archive.finalize();
}
