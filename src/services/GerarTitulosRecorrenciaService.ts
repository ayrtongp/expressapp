import { Db } from 'mongodb';

function calcularStatus(saldo: number, vencimento: string): string {
  if (saldo <= 0) return 'liquidado';
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dataVenc = new Date(vencimento + 'T00:00:00');
  if (dataVenc < hoje) return 'vencido';
  return 'aberto';
}

export async function gerarTitulosRecorrenciaService(
  db: Db
): Promise<{ criados: number; ignorados: number }> {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = agora.getMonth(); // 0-based
  const anoMesStr = `${ano}-${String(mes + 1).padStart(2, '0')}`;

  const recorrencias = await db
    .collection('financeiro_recorrencias')
    .find({ ativo: true })
    .toArray();

  let criados = 0;
  let ignorados = 0;

  for (const rec of recorrencias) {
    const dataInicioMes = rec.dataInicio?.slice(0, 7);
    if (dataInicioMes && dataInicioMes > anoMesStr) continue;

    const dataFimMes = rec.dataFim?.slice(0, 7);
    if (dataFimMes && dataFimMes < anoMesStr) continue;

    const existente = await db.collection('financeiro_titulos').findOne({
      recorrenciaId: rec._id.toString(),
      vencimento: { $regex: `^${anoMesStr}` },
    });

    if (existente) {
      ignorados++;
      continue;
    }

    const ultimoDia = new Date(ano, mes + 1, 0).getDate();
    const dia = Math.min(rec.diaVencimento, ultimoDia);
    const vencimento = `${anoMesStr}-${String(dia).padStart(2, '0')}`;
    const competencia = `${anoMesStr}-01`;
    const status = calcularStatus(rec.valorPadrao, vencimento);
    const now = new Date().toISOString();

    const novoTitulo: Record<string, any> = {
      tipo: rec.tipo,
      descricao: rec.descricaoPadrao,
      categoriaId: rec.categoriaId,
      vencimento,
      competencia,
      valorOriginal: rec.valorPadrao,
      descontos: 0,
      juros: 0,
      multa: 0,
      valorLiquidado: 0,
      saldo: rec.valorPadrao,
      status,
      recorrenciaId: rec._id.toString(),
      createdAt: now,
      updatedAt: now,
    };

    if (rec.contraparteId) novoTitulo.contraparteId = rec.contraparteId;
    if (rec.residenteId) novoTitulo.residenteId = rec.residenteId;
    if (rec.responsavelId) novoTitulo.responsavelId = rec.responsavelId;

    await db.collection('financeiro_titulos').insertOne(novoTitulo);
    criados++;
  }

  return { criados, ignorados };
}
