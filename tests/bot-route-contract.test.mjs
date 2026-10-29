import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { ObjectId } from 'mongodb';
import botModule from '../dist/src/routes/bot.js';
import { planMigration, applyMigration, buildGroupDoc, NEW_GROUPS } from '../scripts/migrate-bot-groups.mjs';
const botRouter = botModule.default;
const route = fs.readFileSync(new URL('../src/routes/bot.ts', import.meta.url), 'utf8');
test('pressao valida 120/80 e rejeita formatos fora do contrato', () => {
  const match = '120/80'.match(/^(\d{2,3})\s*[/x]\s*(\d{2,3})$/i);
  assert.deepEqual(match?.slice(1), ['120', '80']);
  assert.equal('120'.match(/^(\d{2,3})\s*[/x]\s*(\d{2,3})$/i), null);
  assert.match(route, /match\(\/\^\(\\d\{2,3\}\)\\s\*\[\/x\]\\s\*\(\\d\{2,3\}\)\$\/i\)/);
});
test('primeira gravação é atômica e concorrência usa chave única/upsert', () => {
  assert.match(route, /createIndex\([\s\S]*partialFilterExpression: \{ source_reference: \{ \$type: 'string' \} \}/);
  assert.match(route, /includeResultMetadata: true/);
  assert.match(route, /lastErrorObject\?\.upserted/);
  assert.match(route, /session_id: String\(inserted\._id\)/);
  assert.doesNotMatch(route, /sessions\.createIndex/);
});

test('contexto exige bot_whatsapp para não-admin; admin não depende de grupo', () => {
  assert.doesNotMatch(route, /employee\s*=\s*await db\.collection\('funcionarios_clt'\)/);
  assert.match(route, /BOT_WHATSAPP_GROUP = 'bot_whatsapp'/);
  assert.match(route, /if \(!isAdmin && !groups\.includes\(BOT_WHATSAPP_GROUP\)\) return null/);
  assert.doesNotMatch(route, /CONTEXT_GROUPS|MEASUREMENT_GROUPS/);
  assert.doesNotMatch(route, /diretor financeiro/i);
});

test('mapa de comandos centraliza grupo→permissão sem acesso implícito por grupo de tela ou função', () => {
  assert.match(route, /BOT_COMMAND_GROUPS/);
  assert.match(route, /bot_medicao/);
  assert.match(route, /bot_financeiro/);
  assert.doesNotMatch(route, /'medicina'|'equipe_enfermagem'|'coordenacao'|'financeiro'/);
  assert.doesNotMatch(route, /funcionarios_clt/);
  assert.match(route, /ativo: \{ \$in: \['S', true\] \}/);
});

test('medição consulta usuário ativo antes de aceitar grupos', () => {
  const authorized = route.slice(route.indexOf('async function authorizedEmployee'), route.indexOf("router.use(requireBotToken)"));
  assert.match(authorized, /collection\('usuario'\)\.findOne\(\{ _id: new ObjectId\(userId\), ativo:/);
  assert.match(authorized, /if \(!user\) return false/);
});

test('documentação mantém a matriz de autorização por grupos dedicados, sem CLT nem acesso implícito por grupo de tela', () => {
  const docs = fs.readFileSync(new URL('../docs/BOT-API.md', import.meta.url), 'utf8');
  assert.doesNotMatch(docs, /Só autoriza funcionários CLT/);
  assert.doesNotMatch(docs, /CLT|funcionarios_clt/i);
  assert.match(docs, /admin='S'.*usuarios\.gerenciar/s);
  assert.match(docs, /bot_whatsapp/);
  assert.match(docs, /bot_medicao.*medicao_avulsa\.criar/s);
  assert.match(docs, /bot_financeiro.*funcoes_financeiras\.gerenciar/s);
  assert.match(docs, /não concedem mais nada no bot/);
  assert.match(docs, /migrate-bot-groups\.mjs/);
});

test('router real: matriz bot_whatsapp/bot_medicao/bot_financeiro com DB mockado e recusados sem insert', async () => {
  const employeeId = new ObjectId();
  const residentId = new ObjectId();
  const token = 'integration-test-token';
  const cases = [
    ['admin sem grupos bot', true, true, [], { medicao_avulsa: ['criar'], funcoes_financeiras: ['gerenciar'], usuarios: ['gerenciar'] }, 201],
    ['não admin bot_whatsapp+bot_medicao', true, false, ['bot_whatsapp', 'bot_medicao'], { medicao_avulsa: ['criar'] }, 201],
    ['não admin só bot_whatsapp', true, false, ['bot_whatsapp'], {}, 403],
    ['não admin medicina sem bot_whatsapp', true, false, ['medicina'], null, 403],
    ['não admin equipe_enfermagem sem bot_whatsapp', true, false, ['equipe_enfermagem'], null, 403],
    ['não admin bot_medicao sem bot_whatsapp', true, false, ['bot_medicao'], null, 403],
    ['bot_financeiro', true, false, ['bot_whatsapp', 'bot_financeiro'], { funcoes_financeiras: ['gerenciar'] }, 403],
    ['diretor financeiro sem bot_financeiro', true, false, ['bot_whatsapp'], {}, 403],
    ['inativo', false, true, ['bot_whatsapp', 'bot_medicao'], null, 403],
    ['sem grupo nenhum', true, false, [], null, 403],
  ];
  for (const [name, active, isAdmin, groups, expectedPermissions, measurementStatus] of cases) {
    let inserts = 0;
    const db = { collection(name) {
      if (name === 'usuario') return {
        find: () => ({ project: () => ({ toArray: async () => active ? [{ _id: employeeId, nome: 'Ayrton', sobrenome: 'Teste', telefone: '21999999999', ativo: true, admin: isAdmin ? 'S' : 'N' }] : [] }) }),
        findOne: async (q) => (q._id?.equals?.(employeeId) && active) ? { _id: employeeId, admin: isAdmin ? 'S' : 'N' } : null,
      };
      if (name === 'grupos_usuario') return { find: () => ({ project: () => ({ toArray: async () => groups.length ? [{ id_grupo: new ObjectId('507f1f77bcf86cd799439011') }] : [] }) }) };
      if (name === 'grupos') return { find: () => ({ project: () => ({ toArray: async () => groups.map((cod_grupo) => ({ cod_grupo })) }) }) };
      if (name === 'patient') return { findOne: async () => ({ _id: residentId, display_name: 'Residente Teste' }) };
      if (name === 'measurement_session') return { findOneAndUpdate: async () => ({ value: { _id: new ObjectId(), created_at: new Date().toISOString() }, lastErrorObject: { upserted: new ObjectId() } }) };
      if (name === 'measurement') return { insertMany: async () => { inserts += 1; } };
      throw new Error(`collection inesperada: ${name}`);
    }};
    const app = express(); app.use(express.json()); app.locals.db = db; app.use('/api/bot', botRouter);
    const server = createServer(app); await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.BOT_SERVICE_TOKEN = token;
    const context = await fetch(`${base}/api/bot/context?phone=21999999999`, { headers: { Authorization: `Bearer ${token}` } });
    const contextBody = await context.json();
    const measurement = await fetch(`${base}/api/bot/measurements`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: String(employeeId), residentId: String(residentId), type: 'glicemia', value: '100', measuredAt: '2026-01-01T10:00:00.000Z' }) });
    await new Promise((resolve) => server.close(resolve));
    assert.equal(context.status, 200, `${name}: context HTTP`);
    if (expectedPermissions === null) assert.equal(contextBody, null, `${name}: context deveria ser null`);
    else assert.deepEqual(contextBody?.permissions, expectedPermissions, `${name}: permissoes`);
    assert.equal(measurement.status, measurementStatus, `${name}: measurement`);
    assert.equal(inserts, measurementStatus === 201 ? 1 : 0, `${name}: recusado nao deve inserir`);
  }
});

test('medições: cada um dos 9 tipos grava com type_code/unit corretos, respeita limites e é idempotente', async () => {
  const employeeId = new ObjectId();
  const residentId = new ObjectId();
  const token = 'integration-test-token';
  const typeCases = [
    ['pressao', '120/80', [['BP_SYS', 'mmHg', 120], ['BP_DIA', 'mmHg', 80]], '300/80'],
    ['glicemia', '110', [['GLUCOSE', 'mg/dL', 110]], '900'],
    ['temperatura', '36,5', [['TEMP', '°C', 36.5]], '50'],
    ['saturacao', '98', [['SPO2', '%', 98]], '10'],
    ['frequencia_cardiaca', '72', [['HR', 'bpm', 72]], '400'],
    ['frequencia_respiratoria', '16', [['RR', 'ipm', 16]], '100'],
    ['peso', '68,4', [['WEIGHT', 'kg', 68.4]], '500'],
    ['dor', '5', [['PAIN_SCORE', '/10', 5]], '15'],
    ['diurese', '1200', [['DIURESIS', 'ml', 1200]], '9999'],
  ];
  for (const [type, validValue, expected, invalidValue] of typeCases) {
    let insertedDocs = [];
    let sessionCreated = 0;
    const sessionId = new ObjectId();
    const db = { collection(name) {
      if (name === 'usuario') return { findOne: async (q) => q._id?.equals?.(employeeId) ? { _id: employeeId, admin: 'S' } : null };
      if (name === 'grupos_usuario') return { find: () => ({ project: () => ({ toArray: async () => [{ id_grupo: new ObjectId('507f1f77bcf86cd799439011') }] }) }) };
      if (name === 'grupos') return { find: () => ({ project: () => ({ toArray: async () => [{ cod_grupo: 'medicina' }] }) }) };
      if (name === 'patient') return { findOne: async () => ({ _id: residentId, display_name: 'Residente Teste' }) };
      if (name === 'measurement_session') return { findOneAndUpdate: async () => { sessionCreated += 1; return { value: { _id: sessionId, created_at: new Date().toISOString() }, lastErrorObject: { upserted: sessionCreated === 1 ? sessionId : undefined } }; } };
      if (name === 'measurement') return { insertMany: async (docs) => { insertedDocs = docs; } };
      throw new Error(`collection inesperada: ${name}`);
    }};
    const app = express(); app.use(express.json()); app.locals.db = db; app.use('/api/bot', botRouter);
    const server = createServer(app); await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.BOT_SERVICE_TOKEN = token;
    const post = (value) => fetch(`${base}/api/bot/measurements`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: String(employeeId), residentId: String(residentId), type, value, measuredAt: '2026-01-01T10:00:00.000Z' }) });
    const ok = await post(validValue);
    assert.equal(ok.status, 201, `${type}: valor valido`);
    assert.equal(insertedDocs.length, expected.length, `${type}: quantidade de documentos`);
    for (const [code, unit, numeric] of expected) {
      const doc = insertedDocs.find((d) => d.type_code === code);
      assert.ok(doc, `${type}: documento ${code} ausente`);
      assert.equal(doc.unit, unit, `${type}: unit de ${code}`);
      assert.equal(doc.value_numeric, numeric, `${type}: value_numeric de ${code}`);
    }
    const repeat = await post(validValue);
    assert.equal(repeat.status, 200, `${type}: repeticao idempotente`);
    assert.equal(insertedDocs.length, expected.length, `${type}: repeticao nao duplica`);
    const invalid = await post(invalidValue);
    assert.equal(invalid.status, 400, `${type}: valor fora do limite`);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('documentação lista os 9 tipos de medição com type_code e unit do catálogo', () => {
  const docs = fs.readFileSync(new URL('../docs/BOT-API.md', import.meta.url), 'utf8');
  for (const code of ['BP_SYS', 'BP_DIA', 'GLUCOSE', 'TEMP', 'SPO2', 'HR', 'RR', 'WEIGHT', 'PAIN_SCORE', 'DIURESIS']) {
    assert.match(docs, new RegExp(code), `docs devem citar ${code}`);
  }
});

function matchesFilter(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object') {
      if ('$in' in cond) return cond.$in.some((v) => String(v) === String(value));
      if ('$ne' in cond) return String(value) !== String(cond.$ne);
      return false;
    }
    return String(value) === String(cond);
  });
}
function makeMockMigrationDb(data) {
  return { collection(name) {
    const store = data[name];
    return {
      find(filter = {}) {
        const results = store.filter((doc) => matchesFilter(doc, filter));
        return { project: () => ({ toArray: async () => results.map((d) => ({ ...d })) }) };
      },
      findOne: async (filter = {}) => { const doc = store.find((d) => matchesFilter(d, filter)); return doc ? { ...doc } : null; },
      insertOne: async (doc) => { const _id = new ObjectId(); store.push({ _id, ...doc }); return { insertedId: _id }; },
      insertMany: async (docs) => { const insertedIds = []; for (const doc of docs) { const _id = new ObjectId(); store.push({ _id, ...doc }); insertedIds.push(_id); } return { insertedIds }; },
    };
  } };
}

test('migração bot_whatsapp: dry-run só conta, não grava', async () => {
  const medicinaId = new ObjectId();
  const financeiroId = new ObjectId();
  const userClinico = new ObjectId();
  const userFinanceiroFuncao = new ObjectId();
  const userFinanceiroGrupo = new ObjectId();
  const data = {
    grupos: [
      { _id: medicinaId, cod_grupo: 'medicina', nome: 'Medicina' },
      { _id: financeiroId, cod_grupo: 'financeiro', nome: 'Financeiro' },
    ],
    grupos_usuario: [
      { id_usuario: userClinico, id_grupo: medicinaId },
      { id_usuario: userFinanceiroGrupo, id_grupo: financeiroId },
    ],
    usuario: [
      { _id: userClinico, ativo: true, admin: 'N', telefone: '21911111111', funcao: '' },
      { _id: userFinanceiroFuncao, ativo: true, admin: 'N', telefone: '21922222222', funcao: 'Diretor Financeiro' },
      { _id: userFinanceiroGrupo, ativo: true, admin: 'N', telefone: '21944444444', funcao: '' },
      { _id: new ObjectId(), ativo: true, admin: 'S', telefone: '21933333333', funcao: '' },
      { _id: new ObjectId(), ativo: true, admin: 'N', telefone: '', funcao: '' },
      { _id: new ObjectId(), ativo: false, admin: 'N', telefone: '21955555555', funcao: 'Diretor Financeiro' },
      { _id: new ObjectId(), ativo: true, admin: 'N', telefone: '21966666666', funcao: '' },
    ],
  };
  const db = makeMockMigrationDb(data);
  const plan = await planMigration(db);
  assert.equal(plan.groupsToCreate.length, NEW_GROUPS.length, 'deveria precisar criar os 3 grupos novos');
  assert.equal(plan.linksToCreate.length, 6, 'clínico + diretor financeiro por função + financeiro por grupo = 3 usuários x 2 vínculos');
  assert.equal(data.grupos.length, 2, 'dry-run não deve gravar grupos');
  assert.equal(data.grupos_usuario.length, 2, 'dry-run não deve gravar vínculos');
});

test('migração bot_whatsapp: --apply cria grupos e vínculos uma vez; segunda execução não altera nada', async () => {
  const medicinaId = new ObjectId();
  const userClinico = new ObjectId();
  const data = {
    grupos: [{ _id: medicinaId, cod_grupo: 'medicina', nome: 'Medicina' }],
    grupos_usuario: [{ id_usuario: userClinico, id_grupo: medicinaId }],
    usuario: [{ _id: userClinico, ativo: true, admin: 'N', telefone: '21911111111', funcao: '' }],
  };
  const db = makeMockMigrationDb(data);
  const firstPlan = await planMigration(db);
  const firstResult = await applyMigration(db, firstPlan);
  assert.equal(firstResult.groupsCreated, 3, 'deveria criar os 3 grupos novos');
  assert.equal(firstResult.linksCreated, 2, 'deveria criar bot_whatsapp + bot_medicao para o usuário clínico');
  assert.equal(data.grupos.length, 4);
  assert.equal(data.grupos_usuario.length, 3);
  const createdGroupCodes = data.grupos.map((g) => g.cod_grupo).sort();
  assert.deepEqual(createdGroupCodes, ['bot_financeiro', 'bot_medicao', 'bot_whatsapp', 'medicina'].sort());

  const secondPlan = await planMigration(db);
  assert.equal(secondPlan.groupsToCreate.length, 0, 'segunda execução não deve recriar grupos');
  assert.equal(secondPlan.linksToCreate.length, 0, 'segunda execução não deve duplicar vínculos');
  const secondResult = await applyMigration(db, secondPlan);
  assert.equal(secondResult.groupsCreated, 0);
  assert.equal(secondResult.linksCreated, 0);
  assert.equal(data.grupos.length, 4, 'contagem de grupos não muda na segunda execução');
  assert.equal(data.grupos_usuario.length, 3, 'contagem de vínculos não muda na segunda execução');
});

test('migração bot_whatsapp: novo grupo copia o formato do grupo existente (cod_grupo/nome) sem herdar _id', () => {
  const sample = { _id: new ObjectId(), cod_grupo: 'medicina', nome: 'Medicina', ativo: true };
  const doc = buildGroupDoc(sample, 'bot_whatsapp', 'Bot WhatsApp');
  assert.equal(doc.cod_grupo, 'bot_whatsapp');
  assert.equal(doc.nome, 'Bot WhatsApp');
  assert.equal(doc.ativo, true);
  assert.equal('_id' in doc, false);
});
