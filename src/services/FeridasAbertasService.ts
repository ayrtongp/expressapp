import type { Db } from 'mongodb';

const STATUS_FECHADO = /^(encerrada|cancelada)$/i;

function parseCreatedAt(s: string): Date {
  // "YYYY-MM-DD HH:mm:ss" ou ISO
  return new Date(s.replace(' ', 'T'));
}

function diasAtras(data: Date, hoje: Date): number {
  return Math.floor((hoje.getTime() - data.getTime()) / (1000 * 60 * 60 * 24));
}

function fmtDiaMes(data: Date): string {
  const d = String(data.getDate()).padStart(2, '0');
  const m = String(data.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}`;
}

function fmtDataLesao(s: string): string {
  const [ano, mes, dia] = s.split('-');
  return `${dia}/${mes}/${ano.slice(2)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function buildFeridasAbertasMensagem(db: Db): Promise<string> {
  const hoje = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
  );

  const feridas = await db
    .collection('lesoes')
    .find({ status: { $not: STATUS_FECHADO } })
    .toArray();

  const atrasadas: string[] = [];
  const emDia: string[] = [];

  for (const f of feridas) {
    const comentarios: { createdAt: string }[] = f.comentarios ?? [];

    const ultimaAtualizacao = comentarios.length > 0
      ? comentarios.reduce((max, c) =>
          c.createdAt > max.createdAt ? c : max
        ).createdAt
      : null;

    const dataRef = ultimaAtualizacao
      ? parseCreatedAt(ultimaAtualizacao)
      : parseCreatedAt(f.createdAt);

    const dias = diasAtras(dataRef, hoje);
    const tipo = capitalize(f.tipoLesao?.replace(/_/g, ' ') ?? '');
    const status = capitalize(f.status ?? '');
    const inicio = fmtDataLesao(f.dataLesao);

    if (dias > 7) {
      const ultimaLinha = ultimaAtualizacao
        ? `  └ Última atualização: ${fmtDiaMes(dataRef)} (há ${dias} dias) | Início: ${inicio}`
        : `  └ Nunca atualizada | Início: ${inicio}`;

      atrasadas.push(
        `• ${f.userName}\n  └ ${f.regiaoCorpo} — ${tipo} | Status: ${status}\n${ultimaLinha}\n`
      );
    } else {
      const refLabel = ultimaAtualizacao
        ? `Atualizada em ${fmtDiaMes(dataRef)}`
        : `Registrada em ${fmtDiaMes(dataRef)} (sem comentários)`;
      emDia.push(`• ${f.userName} — ${f.regiaoCorpo} | ${refLabel}`);
    }
  }

  const dataHoje = `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
  const linhas: string[] = [`🩹 *Monitoramento de Feridas* — ${dataHoje}`, ''];

  if (feridas.length === 0) {
    linhas.push('✅ Nenhuma ferida em aberto no momento.');
    return linhas.join('\n');
  }

  if (atrasadas.length === 0 && emDia.length === 0) {
    linhas.push('✅ Todas as feridas abertas estão com atualização em dia. Bom trabalho! 👍');
    return linhas.join('\n');
  }

  if (atrasadas.length > 0) {
    linhas.push(`⚠️ *Feridas sem atualização (> 7 dias):* (${atrasadas.length})`, '');
    linhas.push(...atrasadas);
  }

  if (emDia.length > 0) {
    if (atrasadas.length > 0) linhas.push('', '━━━━━━━━━━━━━━');
    linhas.push(`✅ *Feridas abertas em dia:* (${emDia.length})`, '');
    linhas.push(...emDia);
  }

  if (atrasadas.length === 0) {
    linhas.push('', '✅ Todas as feridas abertas estão com atualização em dia. Bom trabalho! 👍');
  }

  return linhas.join('\n');
}
