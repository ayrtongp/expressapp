import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import {
  ALVOS,
  planCreation,
  applyCreation,
  summarizePlan,
  splitName,
} from '../scripts/criar-idosos-de-residentes.mjs';

function matchesFilter(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof ObjectId)) {
      if ('$in' in cond) {
        return cond.$in.some((item) => String(item) === String(value));
      }
      if ('$exists' in cond) return (value !== undefined) === cond.$exists;
      if ('$ne' in cond) return String(value) !== String(cond.$ne);
      return false;
    }
    return String(value) === String(cond);
  });
}

function makeMockDb(data) {
  const writes = [];
  const db = {
    writes,
    data,
    collection(name) {
      const store = (data[name] ??= []);
      return {
        find(filter = {}) {
          const results = store.filter((doc) => matchesFilter(doc, filter));
          const cursor = {
            project() {
              return cursor;
            },
            async toArray() {
              return results.map((doc) => ({ ...doc }));
            },
          };
          return cursor;
        },
        async findOne(filter = {}) {
          const doc = store.find((item) => matchesFilter(item, filter));
          return doc ? { ...doc } : null;
        },
        async insertOne(doc) {
          writes.push({ op: 'insert', collection: name, id: String(doc._id) });
          store.push({ ...doc });
          return { insertedId: doc._id };
        },
        async updateOne(filter, update) {
          const doc = store.find((item) => matchesFilter(item, filter));
          if (!doc) return { matchedCount: 0, modifiedCount: 0 };
          writes.push({ op: 'update', collection: name, id: String(doc._id) });
          Object.assign(doc, update.$set ?? {});
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteOne(filter) {
          const index = store.findIndex((item) => matchesFilter(item, filter));
          if (index < 0) return { deletedCount: 0 };
          writes.push({ op: 'delete', collection: name, id: String(store[index]._id) });
          store.splice(index, 1);
          return { deletedCount: 1 };
        },
      };
    },
  };
  return db;
}

function residente(nome, extra = {}) {
  return {
    _id: new ObjectId(),
    nome,
    is_ativo: 'S',
    data_nascimento: '1940-05-10',
    genero: 'M',
    data_entrada: '2023-01-15',
    numProntuario: 'PR-1',
    ...extra,
  };
}

test('ALVOS: exatamente os 2 residentes aprovados, sem "Idoso teste"', () => {
  assert.deepEqual(ALVOS, ['Memésio Joaquim dos Santos', 'Mariano Jorge Furtado Ramos']);
  assert.ok(!ALVOS.some((nome) => /idoso teste/i.test(nome)));
});

test('splitName: preserva o nome completo no display e usa o mesmo shape dos 47 patients', () => {
  assert.deepEqual(splitName('Memésio Joaquim dos Santos'), {
    given: 'Memésio',
    family: 'Joaquim dos Santos',
  });
  assert.deepEqual(splitName('Mariano'), { given: 'Mariano', family: '' });
  assert.deepEqual(splitName(''), { given: '', family: '' });
});

test('dry-run: monta o plano e não grava nada', async () => {
  const alvoA = residente(ALVOS[0]);
  const alvoB = residente(ALVOS[1], { _id: new ObjectId() });
  const db = makeMockDb({ residentes: [alvoA, alvoB], patient: [], idoso_detalhes: [] });

  const plan = await planCreation(db);
  const resumo = summarizePlan(plan);

  assert.deepEqual(plan.erros, []);
  assert.deepEqual(resumo, { aCriar: 2, pulados: 0, abortados: 0 });
  assert.equal(db.writes.length, 0, 'dry-run nao pode escrever');
  for (const alvo of plan.alvos) {
    assert.equal(alvo.status, 'criar');
    assert.match(alvo.patientIdPlanejado, /^[a-f0-9]{24}$/);
    assert.match(alvo.idosoDetalhesIdPlanejado, /^[a-f0-9]{24}$/);
  }
});

test('apply: cria 1 patient + 1 idoso_detalhes por alvo e liga as duas pontas', async () => {
  const alvoA = residente(ALVOS[0]);
  const alvoB = residente(ALVOS[1], { _id: new ObjectId() });
  const db = makeMockDb({ residentes: [alvoA, alvoB], patient: [], idoso_detalhes: [] });

  const plan = await planCreation(db);
  const resultado = await applyCreation(db, plan);

  assert.equal(resultado.falhas.length, 0);
  assert.equal(resultado.criados.length, 2);
  assert.equal(db.data.patient.length, 2);
  assert.equal(db.data.idoso_detalhes.length, 2);

  for (const [index, criado] of resultado.criados.entries()) {
    const paciente = db.data.patient.find((p) => String(p._id) === criado.patientId);
    const idoso = db.data.idoso_detalhes.find((i) => String(i._id) === criado.idosoDetalhesId);

    assert.ok(paciente, 'patient criado');
    assert.ok(idoso, 'idoso_detalhes criado');

    // Ponte legada e ligação nos dois sentidos.
    assert.equal(paciente.residente_id, String(db.data.residentes[index]._id));
    assert.equal(paciente.idoso_detalhes_id, String(idoso._id));
    assert.equal(idoso.patient_id, String(paciente._id));

    // Formato atual (mesmo shape de C_idosoDetalhes).
    assert.equal(paciente.resourceType, 'Patient');
    assert.equal(paciente.display_name, db.data.residentes[index].nome);
    assert.equal(paciente.given_name, splitName(db.data.residentes[index].nome).given);
    assert.equal(paciente.family_name, splitName(db.data.residentes[index].nome).family);
    assert.equal(paciente.birth_date, '1940-05-10');
    assert.equal(paciente.active, true);
    assert.ok(Array.isArray(paciente.name));
    assert.deepEqual(paciente.telecom, []);
    assert.deepEqual(paciente.address, []);
    assert.deepEqual(paciente.contact, []);
    assert.deepEqual(paciente.extension, {});
    assert.equal(idoso.status, 'ativo');

    // Não cria usuario, não inventa vínculo e não copia dado sensível.
    assert.equal(paciente.usuario_id, undefined);
    assert.equal(idoso.usuarioId, undefined);
    assert.equal(paciente.cpf, undefined);
    assert.equal(paciente.photo_url, undefined);
  }

  // Nunca escreve em residentes.
  assert.equal(db.writes.filter((w) => w.collection === 'residentes').length, 0);
});

test('apply: segunda execução não duplica e relata o alvo como pulado', async () => {
  const alvoA = residente(ALVOS[0]);
  const alvoB = residente(ALVOS[1]);
  const db = makeMockDb({ residentes: [alvoA, alvoB], patient: [], idoso_detalhes: [] });

  await applyCreation(db, await planCreation(db));
  const writesDepoisDaPrimeira = db.writes.length;

  const segundoPlano = await planCreation(db);
  assert.deepEqual(summarizePlan(segundoPlano), { aCriar: 0, pulados: 2, abortados: 0 });

  const segundoResultado = await applyCreation(db, segundoPlano);
  assert.equal(segundoResultado.criados.length, 0);
  assert.equal(db.writes.length, writesDepoisDaPrimeira, 'segunda execucao nao pode escrever');
  assert.equal(db.data.patient.length, 2);
  assert.equal(db.data.idoso_detalhes.length, 2);
});

test('nome ambíguo: aborta sem gravar nada', async () => {
  const db = makeMockDb({
    residentes: [residente(ALVOS[0]), residente(ALVOS[0]), residente(ALVOS[1])],
    patient: [],
    idoso_detalhes: [],
  });

  const plan = await planCreation(db);
  assert.equal(plan.erros.length, 1);
  assert.match(plan.erros[0], /ambíguo/);
  assert.ok(plan.alvos.some((alvo) => alvo.status === 'abortar'));

  const resultado = await applyCreation(db, plan);
  assert.equal(resultado.abortado, true);
  assert.equal(resultado.criados.length, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(db.data.patient.length, 0);
});

test('nome inexistente: aborta sem gravar nada', async () => {
  const db = makeMockDb({ residentes: [residente(ALVOS[1])], patient: [], idoso_detalhes: [] });

  const plan = await planCreation(db);
  assert.equal(plan.erros.length, 1);
  assert.match(plan.erros[0], /nenhum residente/);

  const resultado = await applyCreation(db, plan);
  assert.equal(resultado.abortado, true);
  assert.equal(db.writes.length, 0);
});

test('saída pública não expõe CPF/telefone/endereço (só nomes, ids e contagens)', async () => {
  const alvoA = residente(ALVOS[0], {
    cpf: '123.456.789-00',
    contatoFamiliar: '21999998888',
    enderecoOrigem: 'Rua Sigilosa, 100',
  });
  const db = makeMockDb({ residentes: [alvoA], patient: [], idoso_detalhes: [] });

  const plan = await planCreation(db);
  const texto = JSON.stringify({
    alvos: plan.alvos.map((a) => ({ nome: a.nome, status: a.status, patientIdPlanejado: a.patientIdPlanejado })),
    resumo: summarizePlan(plan),
    erros: plan.erros,
  });

  assert.doesNotMatch(texto, /123\.456\.789-00/);
  assert.doesNotMatch(texto, /21999998888/);
  assert.doesNotMatch(texto, /Rua Sigilosa/);
  assert.match(texto, new RegExp(ALVOS[0]));
});
