// Migração clínica (ADR 0005, etapa B): ACRESCENTA patient_id nas coleções
// clínicas que ainda só têm o id antigo (residentes._id, idoso_detalhes._id,
// usuario._id etc). NUNCA remove o campo antigo (residenteId/residente_id/
// idosoId/userId continuam intactos) e NUNCA cria patient/idoso_detalhes —
// os residentes sem patient só são contados, para decisão humana antes de
// qualquer criação.
//
// Execução (mesma ressalva do migrate-bot-groups.mjs/diag-idosos.mjs: o
// Dockerfile da API não copia scripts/ para a imagem, então roda via stdin):
//   docker exec -i lfz-api node --input-type=module -            < scripts/migrate-clinico.mjs   (dry-run, só conta)
//   docker exec -i lfz-api node --input-type=module - --apply    < scripts/migrate-clinico.mjs   (grava)
// Lê MONGODB_URI/MONGODB_DBNAME do ambiente do container.
// Nunca imprime nome/CPF/telefone/data; só contagens.
import { ObjectId } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Coleção + campo legado que recebe patient_id. Nomes confirmados por
// leitura direta do código do portal — ver levantamento-idosos.md.
export const CLINICAL_TARGETS = [
  { collection: 'prescricoes', field: 'residenteId' },
  { collection: 'sinaisvitais', field: 'residente_id' },
  { collection: 'sinaisvitaisv2', field: 'idosoId' },
  { collection: 'anotacoesenfermagem', field: 'residente_id' },
  { collection: 'lesoes', field: 'userId' },
];

const hex = (value) => (value === null || value === undefined ? '' : String(value));

// Carrega os índices mínimos (só ids/campos de vínculo) das 4 coleções-raiz
// de identidade, uma vez, para resolver tudo em memória sem round-trip por
// documento.
async function loadIdentityIndex(db) {
  const residentesDocs = await db.collection('residentes').find({}).project({ _id: 1 }).toArray();
  const patientDocs = await db.collection('patient').find({}).project({ _id: 1, residente_id: 1, usuario_id: 1, idoso_detalhes_id: 1 }).toArray();
  const idosoDocs = await db.collection('idoso_detalhes').find({}).project({ _id: 1, usuarioId: 1, patient_id: 1 }).toArray();
  const usuarioDocs = await db.collection('usuario').find({}).project({ _id: 1 }).toArray();

  const residentesIds = new Set(residentesDocs.map((r) => hex(r._id)));
  const usuarioIds = new Set(usuarioDocs.map((u) => hex(u._id)));

  const patientById = new Map();
  const patientByResidenteId = new Map();
  const patientByUsuarioId = new Map();
  for (const p of patientDocs) {
    const id = hex(p._id);
    patientById.set(id, p);
    if (p.residente_id) patientByResidenteId.set(hex(p.residente_id), id);
    if (p.usuario_id) patientByUsuarioId.set(hex(p.usuario_id), id);
  }

  const idosoById = new Map();
  const idosoByPatientId = new Map();
  const idosoByUsuarioId = new Map();
  for (const i of idosoDocs) {
    const id = hex(i._id);
    idosoById.set(id, i);
    if (i.patient_id) idosoByPatientId.set(hex(i.patient_id), id);
    if (i.usuarioId) idosoByUsuarioId.set(hex(i.usuarioId), id);
  }

  return { residentesIds, usuarioIds, patientById, patientByResidenteId, patientByUsuarioId, idosoById, idosoByPatientId, idosoByUsuarioId };
}

// Dado qualquer id de pessoa (residentes._id, patient._id, idoso_detalhes._id
// ou usuario._id, string ou ObjectId), resolve patientId/idosoDetalhesId
// seguindo só os vínculos que existem nos dados — sem inventar nenhum.
export function resolveIdentity(index, rawId) {
  const id = hex(rawId);
  if (!id) return { patientId: null, idosoDetalhesId: null, source: null };

  if (index.residentesIds.has(id)) {
    const patientId = index.patientByResidenteId.get(id) ?? null;
    const idosoDetalhesId = patientId ? (index.idosoByPatientId.get(patientId) ?? null) : null;
    return { patientId, idosoDetalhesId, source: 'residentes' };
  }
  if (index.patientById.has(id)) {
    const patientDoc = index.patientById.get(id);
    const idosoDetalhesId = (patientDoc.idoso_detalhes_id ? hex(patientDoc.idoso_detalhes_id) : null) ?? index.idosoByPatientId.get(id) ?? null;
    return { patientId: id, idosoDetalhesId, source: 'patient' };
  }
  if (index.idosoById.has(id)) {
    const idosoDoc = index.idosoById.get(id);
    const patientId = (idosoDoc.patient_id ? hex(idosoDoc.patient_id) : null) ?? index.patientByUsuarioId.get(hex(idosoDoc.usuarioId)) ?? null;
    return { patientId, idosoDetalhesId: id, source: 'idoso_detalhes' };
  }
  if (index.usuarioIds.has(id)) {
    const idosoDetalhesId = index.idosoByUsuarioId.get(id) ?? null;
    let patientId = index.patientByUsuarioId.get(id) ?? null;
    if (!patientId && idosoDetalhesId) {
      const idosoDoc = index.idosoById.get(idosoDetalhesId);
      patientId = idosoDoc?.patient_id ? hex(idosoDoc.patient_id) : null;
    }
    return { patientId, idosoDetalhesId, source: 'usuario' };
  }
  return { patientId: null, idosoDetalhesId: null, source: null };
}

// Calcula o que falta atualizar sem escrever nada no banco.
export async function planMigration(db) {
  const index = await loadIdentityIndex(db);
  const residentesSemPatient = [...index.residentesIds].filter((id) => !index.patientByResidenteId.has(id)).length;

  const perCollection = {};
  for (const { collection, field } of CLINICAL_TARGETS) {
    const col = db.collection(collection);
    const totalComCampo = await col.countDocuments({ [field]: { $exists: true, $ne: null } });
    const semPatientId = await col.find({ [field]: { $exists: true, $ne: null }, patient_id: { $exists: false } })
      .project({ _id: 1, [field]: 1 }).toArray();

    const updates = [];
    let bloqueadoResidenteSemPatient = 0;
    let semResolucaoOutro = 0;
    for (const doc of semPatientId) {
      const resolved = resolveIdentity(index, doc[field]);
      if (resolved.patientId) {
        updates.push({ _id: doc._id, patientId: resolved.patientId });
        continue;
      }
      const rawId = hex(doc[field]);
      if (index.residentesIds.has(rawId) && !index.patientByResidenteId.has(rawId)) bloqueadoResidenteSemPatient += 1;
      else semResolucaoOutro += 1;
    }

    perCollection[collection] = {
      field,
      total: totalComCampo,
      jaTinhaPatientId: totalComCampo - semPatientId.length,
      aAtualizar: updates.length,
      bloqueadoResidenteSemPatient,
      semResolucaoOutro,
      updates,
    };
  }

  return { residentesSemPatient, perCollection };
}

// Aplica o plano: só $set patient_id nos documentos resolvidos. Nunca
// remove o campo antigo, nunca cria patient/idoso_detalhes.
export async function applyMigration(db, plan) {
  const atualizadoPorColecao = {};
  for (const [collection, data] of Object.entries(plan.perCollection)) {
    let atualizado = 0;
    for (const update of data.updates) {
      await db.collection(collection).updateOne({ _id: update._id }, { $set: { patient_id: update.patientId } });
      atualizado += 1;
    }
    atualizadoPorColecao[collection] = atualizado;
  }
  return atualizadoPorColecao;
}

function summarize(plan, atualizadoPorColecao) {
  const perCollection = {};
  for (const [collection, data] of Object.entries(plan.perCollection)) {
    perCollection[collection] = {
      field: data.field,
      total: data.total,
      jaTinhaPatientId: data.jaTinhaPatientId,
      aAtualizar: atualizadoPorColecao ? 0 : data.aAtualizar,
      atualizado: atualizadoPorColecao ? atualizadoPorColecao[collection] : 0,
      bloqueadoResidenteSemPatient: data.bloqueadoResidenteSemPatient,
      semResolucaoOutro: data.semResolucaoOutro,
    };
  }
  return perCollection;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DBNAME;
  if (!uri || !dbName) {
    console.error('MONGODB_URI e MONGODB_DBNAME sao obrigatorios no ambiente.');
    process.exitCode = 1;
    return;
  }
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const plan = await planMigration(db);
    const atualizadoPorColecao = apply ? await applyMigration(db, plan) : null;
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      residentesSemPatient: plan.residentesSemPatient,
      observacao: 'residentesSemPatient precisa de decisao do Ayrton antes de criar patient/idoso_detalhes; este script nunca cria.',
      perCollection: summarize(plan, atualizadoPorColecao),
    }, null, 2));
  } finally {
    await client.close();
  }
}

// Roda main() quando executado direto (node scripts/migrate-clinico.mjs) OU
// quando lido via stdin (`node --input-type=module -`, onde argv[1] é '-').
const invokedPath = process.argv[1];
const invokedDirectly = invokedPath === '-' || invokedPath === undefined
  || fileURLToPath(import.meta.url) === resolve(invokedPath);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('Erro na migracao:', error.message);
    process.exitCode = 1;
  });
}
