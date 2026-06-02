import type { Db } from 'mongodb';

const MESES_EXTENSO = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

function calcularDiaUtil(data: Date): number {
  const inicio = new Date(data.getFullYear(), data.getMonth(), 1);
  const alvo = new Date(data);
  alvo.setHours(0, 0, 0, 0);
  let count = 0;
  for (let d = new Date(inicio); d <= alvo; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0) count++; // domingo não conta; sábado conta
  }
  return count;
}

export function ehDiaDeEnviarAvisoFolha(data: Date = new Date()): boolean {
  const diaUtil = calcularDiaUtil(data);
  return diaUtil >= 2 && diaUtil <= 5;
}

export async function buildFolhaPontoAvisoMensagem(db: Db): Promise<string | null> {
  const hoje = new Date();
  // Avisa sobre o mês anterior
  const mes = hoje.getMonth() === 0 ? 12 : hoje.getMonth();
  const ano = hoje.getMonth() === 0 ? hoje.getFullYear() - 1 : hoje.getFullYear();

  const funcionariosAtivos = await db.collection('funcionarios_clt').aggregate([
    { $match: { status: 'ativo' } },
    { $addFields: { usuarioObjectId: { $toObjectId: '$usuarioId' } } },
    { $lookup: { from: 'usuario', localField: 'usuarioObjectId', foreignField: '_id', as: 'usuarioArr' } },
    { $addFields: { u: { $arrayElemAt: ['$usuarioArr', 0] } } },
    { $project: {
      _id: 1,
      nomeCompleto: { $concat: [{ $ifNull: ['$u.nome', ''] }, ' ', { $ifNull: ['$u.sobrenome', ''] }] },
    }},
  ]).toArray();

  if (funcionariosAtivos.length === 0) return null;

  const documentos = await db.collection('rh_documentos_periodo')
    .find({ tipo: 'folha_ponto', 'periodo.mes': mes, 'periodo.ano': ano })
    .project({ funcionarioId: 1 })
    .toArray();

  const idsEnviados = new Set(documentos.map(d => String(d.funcionarioId)));
  const pendentes = funcionariosAtivos.filter(f => !idsEnviados.has(String(f._id)));

  if (pendentes.length === 0) return null;

  const lista = pendentes
    .map(f => `• ${String(f.nomeCompleto).trim()}`)
    .sort()
    .join('\n');

  return [
    `📋 *Folha de Ponto — ${MESES_EXTENSO[mes - 1]}/${ano}*`,
    '⚠️ Funcionários sem envio:',
    '',
    lista,
    '',
    'Favor enviar até o 5º dia útil.',
  ].join('\n');
}
