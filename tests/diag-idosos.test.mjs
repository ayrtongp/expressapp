import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { diagnose, DEPENDENT_FIELDS } from '../scripts/diag-idosos.mjs';

function matchesFilter(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object') {
      if ('$exists' in cond && cond.$exists === true && (value === undefined)) return false;
      if ('$ne' in cond && value === cond.$ne) return false;
      return true;
    }
    return String(value) === String(cond);
  });
}
function makeMockDb(data) {
  return { collection(name) {
    const store = data[name] ?? [];
    return {
      find(filter = {}) {
        const results = store.filter((doc) => matchesFilter(doc, filter));
        return { project: () => ({ toArray: async () => results.map((d) => ({ ...d })) }) };
      },
    };
  } };
}

test('diag-idosos: não grava nada (só funções de leitura no módulo)', async () => {
  const mod = await import('../scripts/diag-idosos.mjs');
  assert.equal(typeof mod.diagnose, 'function');
  // Garantia estática simples: o módulo não referencia nenhum método de escrita do driver.
  const src = await (await import('node:fs/promises')).readFile(new URL('../scripts/diag-idosos.mjs', import.meta.url), 'utf8');
  for (const writeMethod of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'findOneAndUpdate', 'findOneAndDelete']) {
    assert.doesNotMatch(src, new RegExp(writeMethod), `diag-idosos.mjs nao deve chamar ${writeMethod}`);
  }
});

test('diag-idosos: contagens de residentes/patient/idoso_detalhes e correspondência', async () => {
  const residenteComPatient = new ObjectId();
  const residenteSemPatient = new ObjectId();
  const idosoComPatient = new ObjectId();
  const idosoSemPatient = new ObjectId();
  const patientAtualId = new ObjectId();
  const patientDeprecatedId = new ObjectId();
  const patientOrfaoId = new ObjectId();

  const data = {
    residentes: [
      { _id: residenteComPatient, is_ativo: 'S' },
      { _id: residenteSemPatient, is_ativo: 'N' },
    ],
    patient: [
      { _id: patientAtualId, active: true, usuario_id: String(new ObjectId()), idoso_detalhes_id: String(idosoComPatient) },
      { _id: patientDeprecatedId, active: false, residente_id: String(residenteComPatient) },
      { _id: patientOrfaoId, active: true, residente_id: String(new ObjectId()) },
    ],
    idoso_detalhes: [
      { _id: idosoComPatient, status: 'ativo', usuarioId: String(new ObjectId()), patient_id: String(patientAtualId) },
      { _id: idosoSemPatient, status: 'falecido', usuarioId: String(new ObjectId()) },
    ],
  };
  const db = makeMockDb(data);
  const result = await diagnose(db);

  assert.deepEqual(result.residentes, { total: 2, ativos: 1, inativos: 1, outroStatus: 0 });
  // patientOrfaoId tem residente_id preenchido (mesmo que não resolva a um residentes real),
  // então também conta como "formatoDeprecated"; a não-resolução aparece em correspondencia.*.
  assert.deepEqual(result.patient, { total: 3, ativos: 2, inativos: 1, formatoAtual: 1, formatoDeprecated: 2, semFormatoReconhecido: 0 });
  assert.deepEqual(result.idosoDetalhes.porStatus, { ativo: 1, inativo: 0, falecido: 1, afastado: 0, outro: 0 });
  assert.equal(result.idosoDetalhes.comPatientId, 1);
  assert.equal(result.idosoDetalhes.semPatientId, 1);
  assert.deepEqual(result.correspondencia, {
    residentesComPatientDeprecated: 1,
    residentesSemPatientDeprecated: 1,
    patientFormatoDeprecatedSemResidente: 1,
  });
});

test('diag-idosos: para cada coleção dependente, classifica por residentes/patient/idoso_detalhes/órfão sem imprimir valores', async () => {
  const residenteId = new ObjectId();
  const patientId = new ObjectId();
  const idosoId = new ObjectId();
  const orphanId = new ObjectId();

  const data = {
    residentes: [{ _id: residenteId, is_ativo: 'S' }],
    patient: [{ _id: patientId, active: true }],
    idoso_detalhes: [{ _id: idosoId, status: 'ativo' }],
    sinaisvitais: [
      { _id: new ObjectId(), residente_id: String(residenteId) },
      { _id: new ObjectId(), residente_id: String(orphanId) },
    ],
    measurement_session: [
      { _id: new ObjectId(), patient_id: String(patientId) },
    ],
    prescricoes: [
      { _id: new ObjectId(), residenteId: String(residenteId) },
      { _id: new ObjectId(), residenteId: String(idosoId) },
    ],
    arquivosr2: [
      { _id: new ObjectId(), collection: 'fotos', folder: String(idosoId) },
      { _id: new ObjectId(), collection: 'arquivos', folder: String(residenteId) }, // filtrado fora por extraFilter
    ],
  };
  const db = makeMockDb(data);
  const result = await diagnose(db);

  assert.equal(DEPENDENT_FIELDS.find((d) => d.collection === 'sinaisvitais').field, 'residente_id');
  assert.deepEqual(result.dependents.sinaisvitais, { field: 'residente_id', total: 2, apontaResidentes: 1, apontaPatient: 0, apontaIdosoDetalhes: 0, orfaos: 1 });
  assert.deepEqual(result.dependents.measurement_session, { field: 'patient_id', total: 1, apontaResidentes: 0, apontaPatient: 1, apontaIdosoDetalhes: 0, orfaos: 0 });
  assert.deepEqual(result.dependents.prescricoes, { field: 'residenteId', total: 2, apontaResidentes: 1, apontaPatient: 0, apontaIdosoDetalhes: 1, orfaos: 0 });
  // arquivosr2 com extraFilter collection:'fotos' só deve contar o doc de foto, não o de "arquivos".
  assert.deepEqual(result.dependents.arquivosr2, { field: 'folder', total: 1, apontaResidentes: 0, apontaPatient: 0, apontaIdosoDetalhes: 1, orfaos: 0 });
});
