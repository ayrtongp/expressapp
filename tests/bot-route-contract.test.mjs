import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { ObjectId } from 'mongodb';
import botModule from '../dist/src/routes/bot.js';
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

test('contexto autoriza não-CLT por role e nega usuário sem grupo', () => {
  assert.doesNotMatch(route, /employee\s*=\s*await db\.collection\('funcionarios_clt'\)/);
  assert.match(route, /CONTEXT_GROUPS/);
  assert.match(route, /diretor financeiro/);
  assert.match(route, /isAdmin.*isFinanceDirector.*groups\.some\(\(group\) => CONTEXT_GROUPS\.has\(group\)\)/s);
});

test('allowlist explícita cobre cada role sem conceder acesso implícito', () => {
  for (const role of ['medicina', 'equipe_enfermagem', 'coordenacao', 'financeiro']) {
    assert.match(route, new RegExp(role));
  }
  assert.match(route, /permissions\.usuarios = \['gerenciar'\]/);
  assert.match(route, /permissions\.funcoes_financeiras = \['gerenciar'\]/);
  assert.match(route, /permissions\.medicao_avulsa = \['criar'\]/);
  assert.doesNotMatch(route, /funcionarios_clt/);
  assert.match(route, /ativo: \{ \$in: \['S', true\] \}/);
});

test('medição consulta usuário ativo antes de aceitar grupos', () => {
  const authorized = route.slice(route.indexOf('async function authorizedEmployee'), route.indexOf("router.use(requireBotToken)"));
  assert.match(authorized, /collection\('usuario'\)\.findOne\(\{ _id: new ObjectId\(userId\), ativo:/);
  assert.match(authorized, /if \(!user\) return false/);
});

test('documentação mantém a matriz de autorização sem requisito CLT', () => {
  const docs = fs.readFileSync(new URL('../docs/BOT-API.md', import.meta.url), 'utf8');
  assert.doesNotMatch(docs, /Só autoriza funcionários CLT/);
  assert.doesNotMatch(docs, /CLT|funcionarios_clt/i);
  assert.match(docs, /admin=S.*usuarios\.gerenciar/s);
  assert.match(docs, /Diretor Financeiro.*financeiro.*funcoes_financeiras/s);
  assert.match(docs, /medicina.*equipe_enfermagem.*coordenacao.*medicao_avulsa/s);
});

test('router real: contexto/medição com DB mockado e recusados sem insert', async () => {
  const employeeId = new ObjectId();
  const residentId = new ObjectId();
  const token = 'integration-test-token';
  const cases = [
    ['admin S não-CLT', true, ['admin'], 200, 403], ['diretor financeiro não-CLT', true, ['diretor financeiro'], 200, 403], ['financeiro', true, ['financeiro'], 200, 403],
    ['medicina não-CLT', true, ['medicina'], 200, 201], ['enfermagem não-CLT', true, ['equipe_enfermagem'], 200, 201],
    ['coordenação não-CLT', true, ['coordenacao'], 200, 201],
    ['sem grupo', true, [], null, 403], ['inativo', false, ['admin'], null, 403], ['role desconhecida', true, ['visitante'], null, 403],
  ];
  for (const [name, active, roles, contextStatus, measurementStatus] of cases) {
    let inserts = 0;
    const db = { collection(name) {
      if (name === 'usuario') return { find: () => ({ project: () => ({ toArray: async () => active ? [{ _id: employeeId, nome: 'Ayrton', sobrenome: 'Teste', telefone: '21999999999', ativo: true, admin: roles.includes('admin') ? 'S' : 'N', funcao: roles.includes('diretor financeiro') ? 'Diretor Financeiro' : '' }] : [] }) }), findOne: async (q) => q._id?.equals?.(employeeId) && active ? { _id: employeeId, nome: 'Ayrton', sobrenome: 'Teste', admin: roles.includes('admin') ? 'S' : 'N', funcao: roles.includes('diretor financeiro') ? 'Diretor Financeiro' : '' } : null };
      if (name === 'grupos_usuario') return { find: () => ({ project: () => ({ toArray: async () => roles.length ? [{ id_grupo: new ObjectId('507f1f77bcf86cd799439011') }] : [] }) }) };
      if (name === 'grupos') return { find: () => ({ project: () => ({ toArray: async () => roles.filter((r) => !['admin', 'diretor financeiro'].includes(r)).map((cod_grupo) => ({ cod_grupo })) }) }) };
      if (name === 'patient') return { findOne: async () => ({ _id: residentId, display_name: 'Residente Teste' }) };
      if (name === 'measurement_session') return { createIndex: async () => undefined, findOneAndUpdate: async () => ({ value: { _id: new ObjectId(), created_at: new Date().toISOString() }, lastErrorObject: { upserted: new ObjectId() } }) };
      if (name === 'measurement') return { insertMany: async () => { inserts += 1; } };
      throw new Error(`collection inesperada: ${name}`);
    }};
    const app = express(); app.use(express.json()); app.locals.db = db; app.use('/api/bot', botRouter);
    const server = createServer(app); await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.BOT_SERVICE_TOKEN = token;
    const context = await fetch(`${base}/api/bot/context?phone=21999999999`, { headers: { Authorization: `Bearer ${token}` } });
    const measurement = await fetch(`${base}/api/bot/measurements`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId: String(employeeId), residentId: String(residentId), type: 'glicemia', value: '100', measuredAt: '2026-01-01T10:00:00.000Z' }) });
    await new Promise((resolve) => server.close(resolve));
    assert.equal(context.status, 200, `${name}: context HTTP`);
    assert.equal((await context.json()) === null ? null : 200, contextStatus, `${name}: context body`);
    assert.equal(measurement.status, measurementStatus, `${name}: measurement`);
    assert.equal(inserts, measurementStatus === 201 ? 1 : 0, `${name}: rejected request inserted data`);
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
