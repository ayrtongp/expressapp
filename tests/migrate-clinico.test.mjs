import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import { resolveIdentity, planMigration, applyMigration, CLINICAL_TARGETS } from '../scripts/migrate-clinico.mjs';

function hex(id) { return String(id); }

test('resolveIdentity: resolve pelos 4 ramos (residentes/patient/idoso_detalhes/usuario) e retorna null quando nao casa', () => {
  const residenteComPatient = new ObjectId();
  const patientDeprecated = new ObjectId();
  const idosoDoPatientDeprecated = new ObjectId();
  const patientDireto = new ObjectId();
  const idosoDoPatientDireto = new ObjectId();
  const idosoDireto = new ObjectId();
  const patientDoIdosoDireto = new ObjectId();
  const usuarioId = new ObjectId();
  const idosoDoUsuario = new ObjectId();
  const patientDoUsuario = new ObjectId();

  const index = {
    residentesIds: new Set([hex(residenteComPatient)]),
    usuarioIds: new Set([hex(usuarioId)]),
    patientById: new Map([
      [hex(patientDireto), { idoso_detalhes_id: hex(idosoDoPatientDireto) }],
    ]),
    patientByResidenteId: new Map([[hex(residenteComPatient), hex(patientDeprecated)]]),
    patientByUsuarioId: new Map([[hex(usuarioId), hex(patientDoUsuario)]]),
    idosoById: new Map([
      [hex(idosoDireto), { patient_id: hex(patientDoIdosoDireto) }],
    ]),
    idosoByPatientId: new Map([[hex(patientDeprecated), hex(idosoDoPatientDeprecated)]]),
    idosoByUsuarioId: new Map([[hex(usuarioId), hex(idosoDoUsuario)]]),
  };

  assert.deepEqual(resolveIdentity(index, residenteComPatient), { patientId: hex(patientDeprecated), idosoDetalhesId: hex(idosoDoPatientDeprecated), source: 'residentes' });
  assert.deepEqual(resolveIdentity(index, patientDireto), { patientId: hex(patientDireto), idosoDetalhesId: hex(idosoDoPatientDireto), source: 'patient' });
  assert.deepEqual(resolveIdentity(index, idosoDireto), { patientId: hex(patientDoIdosoDireto), idosoDetalhesId: hex(idosoDireto), source: 'idoso_detalhes' });
  assert.deepEqual(resolveIdentity(index, usuarioId), { patientId: hex(patientDoUsuario), idosoDetalhesId: hex(idosoDoUsuario), source: 'usuario' });
  assert.deepEqual(resolveIdentity(index, new ObjectId()), { patientId: null, idosoDetalhesId: null, source: null });
  assert.deepEqual(resolveIdentity(index, null), { patientId: null, idosoDetalhesId: null, source: null });
});

test('resolveIdentity: ramo patient sem idoso_detalhes_id cai no mapa reverso idosoByPatientId; ramo idoso_detalhes sem patient_id cai no mapa reverso patientByUsuarioId', () => {
  const patientSemCampo = new ObjectId();
  const idosoViaReverso = new ObjectId();
  const idosoSemPatientId = new ObjectId();
  const usuarioDoIdoso = new ObjectId();
  const patientViaReverso = new ObjectId();

  const index = {
    residentesIds: new Set(),
    usuarioIds: new Set(),
    patientById: new Map([[hex(patientSemCampo), {}]]),
    patientByResidenteId: new Map(),
    patientByUsuarioId: new Map([[hex(usuarioDoIdoso), hex(patientViaReverso)]]),
    idosoById: new Map([[hex(idosoSemPatientId), { usuarioId: hex(usuarioDoIdoso) }]]),
    idosoByPatientId: new Map([[hex(patientSemCampo), hex(idosoViaReverso)]]),
    idosoByUsuarioId: new Map(),
  };

  assert.deepEqual(resolveIdentity(index, patientSemCampo), { patientId: hex(patientSemCampo), idosoDetalhesId: hex(idosoViaReverso), source: 'patient' });
  assert.deepEqual(resolveIdentity(index, idosoSemPatientId), { patientId: hex(patientViaReverso), idosoDetalhesId: hex(idosoSemPatientId), source: 'idoso_detalhes' });
});

function matchesFilter(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object') {
      if ('$exists' in cond) {
        const exists = value !== undefined && value !== null;
        if (cond.$exists === true && !exists) return false;
        if (cond.$exists === false && exists) return false;
      }
      if ('$ne' in cond && value === cond.$ne) return false;
      return true;
    }
    return String(value) === String(cond);
  });
}
function makeMockDb(data) {
  return { collection(name) {
    const store = data[name] ?? (data[name] = []);
    return {
      find(filter = {}) {
        const results = store.filter((doc) => matchesFilter(doc, filter));
        return { project: () => ({ toArray: async () => results.map((d) => ({ ...d })) }) };
      },
      countDocuments: async (filter = {}) => store.filter((doc) => matchesFilter(doc, filter)).length,
      updateOne: async (filter, update) => {
        const doc = store.find((d) => matchesFilter(d, filter));
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { matchedCount: doc ? 1 : 0 };
      },
    };
  } };
}

test('migração clínica: dry-run resolve pelos 4 formatos, bloqueia residente sem patient e conta órfão real, sem gravar', async () => {
  const residenteComPatient = new ObjectId();
  const residenteSemPatient = new ObjectId();
  const patientId = new ObjectId();
  const idosoId = new ObjectId();
  const orphanId = new ObjectId();

  const data = {
    residentes: [{ _id: residenteComPatient }, { _id: residenteSemPatient }],
    patient: [{ _id: patientId, residente_id: String(residenteComPatient) }],
    idoso_detalhes: [{ _id: idosoId, patient_id: String(patientId) }],
    usuario: [],
    prescricoes: [
      { _id: new ObjectId(), residenteId: String(idosoId) }, // idoso_detalhes direto -> resolve
      { _id: new ObjectId(), residenteId: String(residenteComPatient) }, // residentes deprecated -> resolve
      { _id: new ObjectId(), residenteId: String(residenteSemPatient) }, // bloqueado
      { _id: new ObjectId(), residenteId: String(orphanId) }, // sem resolucao
      { _id: new ObjectId(), residenteId: String(idosoId), patient_id: String(patientId) }, // ja tinha
    ],
    sinaisvitais: [{ _id: new ObjectId(), residente_id: String(residenteComPatient) }],
    sinaisvitaisv2: [{ _id: new ObjectId(), idosoId: String(residenteComPatient) }],
    anotacoesenfermagem: [{ _id: new ObjectId(), residente_id: String(residenteComPatient) }],
    lesoes: [{ _id: new ObjectId(), userId: String(residenteComPatient) }],
  };
  const db = makeMockDb(data);
  const plan = await planMigration(db);

  assert.equal(plan.residentesSemPatient, 1);
  assert.deepEqual(
    { total: plan.perCollection.prescricoes.total, jaTinhaPatientId: plan.perCollection.prescricoes.jaTinhaPatientId, aAtualizar: plan.perCollection.prescricoes.aAtualizar, bloqueadoResidenteSemPatient: plan.perCollection.prescricoes.bloqueadoResidenteSemPatient, semResolucaoOutro: plan.perCollection.prescricoes.semResolucaoOutro },
    { total: 5, jaTinhaPatientId: 1, aAtualizar: 2, bloqueadoResidenteSemPatient: 1, semResolucaoOutro: 1 },
  );
  for (const name of ['sinaisvitais', 'sinaisvitaisv2', 'anotacoesenfermagem', 'lesoes']) {
    assert.equal(plan.perCollection[name].aAtualizar, 1, `${name}: deveria resolver 1 documento`);
  }
  // dry-run nao grava nada: so o doc que ja tinha patient_id antes do plano deve te-lo
  assert.equal(data.prescricoes.filter((d) => 'patient_id' in d).length, 1);
  for (const name of ['sinaisvitais', 'sinaisvitaisv2', 'anotacoesenfermagem', 'lesoes']) {
    assert.equal(data[name].filter((d) => 'patient_id' in d).length, 0, `${name}: dry-run nao deve gravar`);
  }
});

test('migração clínica: --apply grava uma vez; segunda execução não altera nada (idempotente); bloqueado continua bloqueado', async () => {
  const residenteComPatient = new ObjectId();
  const residenteSemPatient = new ObjectId();
  const patientId = new ObjectId();

  const data = {
    residentes: [{ _id: residenteComPatient }, { _id: residenteSemPatient }],
    patient: [{ _id: patientId, residente_id: String(residenteComPatient) }],
    idoso_detalhes: [],
    usuario: [],
    sinaisvitais: [
      { _id: new ObjectId(), residente_id: String(residenteComPatient) },
      { _id: new ObjectId(), residente_id: String(residenteSemPatient) },
    ],
    sinaisvitaisv2: [], anotacoesenfermagem: [], lesoes: [], prescricoes: [],
  };
  const db = makeMockDb(data);

  const firstPlan = await planMigration(db);
  assert.equal(firstPlan.perCollection.sinaisvitais.aAtualizar, 1);
  assert.equal(firstPlan.perCollection.sinaisvitais.bloqueadoResidenteSemPatient, 1);
  const firstApply = await applyMigration(db, firstPlan);
  assert.equal(firstApply.sinaisvitais, 1);
  const resolved = data.sinaisvitais.find((d) => hex(d.residente_id) === hex(residenteComPatient));
  assert.equal(resolved.patient_id, String(patientId));
  assert.equal(resolved.residente_id, String(residenteComPatient), 'campo antigo nunca deve ser removido');

  const secondPlan = await planMigration(db);
  assert.equal(secondPlan.perCollection.sinaisvitais.aAtualizar, 0, 'segunda execucao nao deve re-resolver o que ja foi gravado');
  assert.equal(secondPlan.perCollection.sinaisvitais.bloqueadoResidenteSemPatient, 1, 'bloqueado continua bloqueado ate existir patient para o residente');
  const secondApply = await applyMigration(db, secondPlan);
  assert.equal(secondApply.sinaisvitais, 0);
});

test('CLINICAL_TARGETS cobre as 5 colecoes clinicas pedidas com os campos reais', () => {
  const byCollection = Object.fromEntries(CLINICAL_TARGETS.map((t) => [t.collection, t.field]));
  assert.deepEqual(byCollection, {
    prescricoes: 'residenteId',
    sinaisvitais: 'residente_id',
    sinaisvitaisv2: 'idosoId',
    anotacoesenfermagem: 'residente_id',
    lesoes: 'userId',
  });
});
