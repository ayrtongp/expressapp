// Diagnóstico somente leitura da duplicação de cadastro de idosos
// (residentes x patient/idoso_detalhes). Nunca grava nada no banco — o
// módulo só usa find/project/toArray do driver, sem nenhum método de
// escrita. Imprime só contagens, nunca nome/CPF/telefone/data.
//
// Execução (mesma ressalva do migrate-bot-groups.mjs: o Dockerfile da API
// não copia scripts/ para a imagem, então roda via stdin):
//   docker exec -i lfz-api node --input-type=module - < scripts/diag-idosos.mjs
// Lê MONGODB_URI/MONGODB_DBNAME do ambiente do container.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Coleções dependentes e o campo que liga cada documento a uma pessoa.
// Nomes de coleção/campo confirmados por leitura direta do código do
// portal (larfelizidademarica) — ver /var/lib/openbot/OpenBot/Shared/levantamento-idosos.md.
export const DEPENDENT_FIELDS = [
  { collection: 'sinaisvitais', field: 'residente_id' },
  { collection: 'sinaisvitaisv2', field: 'idosoId' },
  { collection: 'anotacoesenfermagem', field: 'residente_id' },
  { collection: 'lesoes', field: 'userId' },
  { collection: 'arquivosr2', field: 'folder', extraFilter: { collection: 'fotos' } },
  { collection: 'prescricoes', field: 'residenteId' },
  { collection: 'agenda_visitas', field: 'residente_id' },
  { collection: 'mensagens_familia', field: 'residente_id' },
  { collection: 'boletins_familia', field: 'residente_id' },
  { collection: 'familiar_residente', field: 'residente_id' },
  { collection: 'financeiro_titulos', field: 'residenteId' },
  { collection: 'financeiro_movimentacoes', field: 'residenteId' },
  { collection: 'measurement_session', field: 'patient_id' },
];

const hex = (value) => String(value ?? '');

async function idSet(db, collectionName) {
  const docs = await db.collection(collectionName).find({}).project({ _id: 1 }).toArray();
  return new Set(docs.map((d) => hex(d._id)));
}

// Calcula todas as contagens sem escrever nada no banco.
export async function diagnose(db) {
  const residentesCol = db.collection('residentes');
  const patientCol = db.collection('patient');
  const idosoCol = db.collection('idoso_detalhes');

  const residentesDocs = await residentesCol.find({}).project({ is_ativo: 1 }).toArray();
  const residentes = {
    total: residentesDocs.length,
    ativos: residentesDocs.filter((r) => r.is_ativo === 'S').length,
    inativos: residentesDocs.filter((r) => r.is_ativo === 'N').length,
  };
  residentes.outroStatus = residentes.total - residentes.ativos - residentes.inativos;
  const residentesIds = new Set(residentesDocs.map((r) => hex(r._id)));

  const patientDocs = await patientCol.find({}).project({ active: 1, usuario_id: 1, residente_id: 1, idoso_detalhes_id: 1 }).toArray();
  const patient = {
    total: patientDocs.length,
    ativos: patientDocs.filter((p) => p.active === true).length,
    inativos: patientDocs.filter((p) => p.active === false).length,
    formatoAtual: patientDocs.filter((p) => !!p.usuario_id).length,
    formatoDeprecated: patientDocs.filter((p) => !p.usuario_id && !!p.residente_id).length,
  };
  patient.semFormatoReconhecido = patient.total - patient.formatoAtual - patient.formatoDeprecated;
  const patientIds = new Set(patientDocs.map((p) => hex(p._id)));

  const idosoDocs = await idosoCol.find({}).project({ status: 1, usuarioId: 1, patient_id: 1 }).toArray();
  const idosoDetalhes = {
    total: idosoDocs.length,
    porStatus: { ativo: 0, inativo: 0, falecido: 0, afastado: 0, outro: 0 },
    comPatientId: idosoDocs.filter((i) => !!i.patient_id).length,
    semPatientId: idosoDocs.filter((i) => !i.patient_id).length,
  };
  for (const doc of idosoDocs) {
    const key = ['ativo', 'inativo', 'falecido', 'afastado'].includes(doc.status) ? doc.status : 'outro';
    idosoDetalhes.porStatus[key] += 1;
  }
  const idosoIds = new Set(idosoDocs.map((i) => hex(i._id)));

  // Correspondência residentes <-> patient (formato deprecated: patient.residente_id = residentes._id).
  const patientResidenteIds = new Set(
    patientDocs.filter((p) => !!p.residente_id).map((p) => hex(p.residente_id)),
  );
  const residentesComPatient = [...residentesIds].filter((id) => patientResidenteIds.has(id)).length;
  const residentesSemPatient = residentes.total - residentesComPatient;
  const patientSemResidenteCorrespondente = patientDocs.filter(
    (p) => !!p.residente_id && !residentesIds.has(hex(p.residente_id)),
  ).length;

  const dependents = {};
  for (const { collection, field, extraFilter } of DEPENDENT_FIELDS) {
    const filter = { ...(extraFilter ?? {}), [field]: { $exists: true, $ne: null } };
    const docs = await db.collection(collection).find(filter).project({ [field]: 1 }).toArray();
    let apontaResidentes = 0;
    let apontaPatient = 0;
    let apontaIdosoDetalhes = 0;
    let orfaos = 0;
    for (const doc of docs) {
      const key = hex(doc[field]);
      if (!key) { orfaos += 1; continue; }
      if (residentesIds.has(key)) apontaResidentes += 1;
      else if (patientIds.has(key)) apontaPatient += 1;
      else if (idosoIds.has(key)) apontaIdosoDetalhes += 1;
      else orfaos += 1;
    }
    dependents[collection] = { field, total: docs.length, apontaResidentes, apontaPatient, apontaIdosoDetalhes, orfaos };
  }

  return {
    residentes,
    patient,
    idosoDetalhes,
    correspondencia: {
      residentesComPatientDeprecated: residentesComPatient,
      residentesSemPatientDeprecated: residentesSemPatient,
      patientFormatoDeprecatedSemResidente: patientSemResidenteCorrespondente,
    },
    dependents,
  };
}

async function main() {
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
    const result = await diagnose(db);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

// Roda main() quando executado direto (node scripts/diag-idosos.mjs) OU
// quando lido via stdin (`node --input-type=module -`, onde argv[1] é '-').
const invokedPath = process.argv[1];
const invokedDirectly = invokedPath === '-' || invokedPath === undefined
  || fileURLToPath(import.meta.url) === resolve(invokedPath);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('Erro no diagnostico:', error.message);
    process.exitCode = 1;
  });
}
