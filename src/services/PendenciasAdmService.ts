import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) return true;
  return false;
}

function primeiroNome(nome: string): string {
  return nome?.split(' ')[0] ?? nome;
}

export async function buildPendenciasAdmMensagem(db: Db): Promise<string> {
  const linhas: string[] = ['📋 *Pendências Administrativas*', ''];

  // --- Residentes sem foto ---
  const todosResidentes = await db
    .collection('residentes')
    .find({ is_ativo: 'S' })
    .project({ _id: 1, nome: 1, foto_base64: 1 })
    .sort({ nome: 1 })
    .toArray();

  const resIds = todosResidentes.map(r => r._id.toString());
  const fotosResR2 = await db
    .collection('arquivosr2')
    .find({ collection: 'foto_perfil', folder: { $in: resIds } })
    .project({ folder: 1 })
    .toArray();
  const resComFotoR2 = new Set(fotosResR2.map(f => f.folder));

  const resSemFoto = todosResidentes.filter(
    r => isEmpty(r.foto_base64) && !resComFotoR2.has(r._id.toString())
  );

  if (resSemFoto.length > 0) {
    linhas.push(`*Residentes sem foto* (${resSemFoto.length}):`);
    for (const r of resSemFoto) linhas.push(`  • ${r.nome}`);
  } else {
    linhas.push('✅ Todos os residentes têm foto.');
  }

  // --- Funcionários CLT com dados incompletos ---
  const clts = await db
    .collection('funcionarios_clt')
    .find({ status: 'ativo' })
    .toArray();

  if (clts.length === 0) {
    linhas.push('', '✅ Nenhum funcionário CLT ativo cadastrado.');
    return linhas.join('\n');
  }

  // Buscar usuarios para nome + foto
  const userIds: string[] = clts.flatMap(c =>
    c.usuarioId ? [c.usuarioId.toString()] : []
  );
  const objIds: ObjectId[] = userIds.flatMap(id =>
    ObjectId.isValid(id) ? [new ObjectId(id)] : []
  );

  const usuarios = await db
    .collection('usuario')
    .find({ _id: { $in: objIds } })
    .project({ _id: 1, nome: 1, sobrenome: 1, foto_base64: 1 })
    .toArray();

  const usuarioMap = new Map(usuarios.map(u => [u._id.toString(), u]));

  // Ids com foto no R2 (collection: foto_perfil, folder = usuarioId)
  const fotosR2 = await db
    .collection('arquivosr2')
    .find({ collection: 'foto_perfil', folder: { $in: userIds } })
    .project({ folder: 1 })
    .toArray();

  const comFotoR2 = new Set(fotosR2.map(f => f.folder));

  const pendentes: string[] = [];

  for (const c of clts) {
    const uid = c.usuarioId?.toString();
    const usr = usuarioMap.get(uid);
    const nomeCompleto = usr ? [usr.nome, usr.sobrenome].filter(Boolean).join(' ') : `(id: ${c.usuarioId})`;

    const temFoto = (!isEmpty(usr?.foto_base64)) || comFotoR2.has(uid);

    const faltando: string[] = [];

    if (isEmpty(c.contrato?.dataAdmissao))  faltando.push('Data admissão');
    if (isEmpty(c.contrato?.salarioBase))   faltando.push('Salário');
    if (isEmpty(c.dadosPessoais?.cpf))      faltando.push('CPF');
    if (isEmpty(c.pisPasep))                faltando.push('PIS/PASEP');
    if (isEmpty(c.ctps))                    faltando.push('CTPS');
    if (isEmpty(c.dadosBancarios))          faltando.push('Dados bancários');
    if (isEmpty(c.endereco))                faltando.push('Endereço');
    if (isEmpty(c.contatoEmergencia))       faltando.push('Contato emergência');
    if (!temFoto)                           faltando.push('Foto');

    if (faltando.length > 0) {
      pendentes.push(`  • ${nomeCompleto}\n    ↳ ${faltando.join(', ')}`);
    }
  }

  linhas.push('');
  if (pendentes.length > 0) {
    linhas.push(`*Funcionários CLT com dados incompletos* (${pendentes.length}):`);
    linhas.push(...pendentes);
  } else {
    linhas.push('✅ Todos os funcionários CLT estão com dados completos.');
  }

  // --- Listas de compras vencidas ---
  const hoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const listasVencidas = await db
    .collection('listas_compras')
    .find({
      data: { $lt: hoje },
      status: { $ne: 'comprada' },
      ativo: { $ne: false },
    })
    .project({ tipo: 1, titulo: 1, data: 1 })
    .sort({ data: 1 })
    .toArray();

  linhas.push('');
  if (listasVencidas.length > 0) {
    linhas.push(`*Listas de compras vencidas* (${listasVencidas.length}):`);
    for (const l of listasVencidas) {
      const [ano, mes, dia] = l.data.split('-');
      const tipo = l.tipo.charAt(0).toUpperCase() + l.tipo.slice(1);
      linhas.push(`  • ${dia}/${mes}/${ano} — ${tipo}: ${l.titulo}`);
    }
  } else {
    linhas.push('✅ Nenhuma lista de compras vencida.');
  }

  return linhas.join('\n');
}

