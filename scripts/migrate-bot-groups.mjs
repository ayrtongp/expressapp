// Migração dos grupos do bot do WhatsApp (bot_whatsapp/bot_medicao/bot_financeiro).
// Execução (lê MONGODB_URI/MONGODB_DBNAME do ambiente do container):
//   docker exec lfz-api node /app/scripts/migrate-bot-groups.mjs            (dry-run, só conta)
//   docker exec lfz-api node /app/scripts/migrate-bot-groups.mjs --apply    (grava)
// Se preferir copiar o conteúdo por stdin, force ESM:
//   docker exec -i lfz-api node --input-type=module - < scripts/migrate-bot-groups.mjs
// Nunca imprime nome/telefone de usuário; só contagens.
import { fileURLToPath } from 'node:url';

export const NEW_GROUPS = [
  { cod_grupo: 'bot_whatsapp', label: 'Bot WhatsApp' },
  { cod_grupo: 'bot_medicao', label: 'Bot WhatsApp - Medicao' },
  { cod_grupo: 'bot_financeiro', label: 'Bot WhatsApp - Financeiro' },
];
const CLINICAL_SCREEN_GROUPS = ['medicina', 'equipe_enfermagem', 'coordenacao'];
const onlyDigits = (value) => String(value ?? '').replace(/\D/g, '');
const codeOf = (doc) => String(doc?.cod_grupo ?? '').trim().toLowerCase();

export function buildGroupDoc(sampleDoc, codGrupo, label) {
  const doc = sampleDoc ? { ...sampleDoc } : {};
  delete doc._id;
  for (const key of Object.keys(doc)) {
    const value = doc[key];
    if (key === 'cod_grupo') doc[key] = codGrupo;
    else if (typeof value === 'string' && /nome|descric|label/i.test(key)) doc[key] = label;
    else if (value instanceof Date) doc[key] = new Date();
  }
  if (!('cod_grupo' in doc)) doc.cod_grupo = codGrupo;
  return doc;
}

export function buildLinkDoc(sampleDoc, userId, groupId) {
  const doc = sampleDoc ? { ...sampleDoc } : {};
  delete doc._id;
  for (const key of Object.keys(doc)) {
    if (/id_usuario/i.test(key)) doc[key] = userId;
    else if (/id_grupo/i.test(key)) doc[key] = groupId;
    else if (doc[key] instanceof Date) doc[key] = new Date();
  }
  if (!('id_usuario' in doc)) doc.id_usuario = userId;
  if (!('id_grupo' in doc)) doc.id_grupo = groupId;
  return doc;
}

// Calcula o que falta criar sem escrever nada no banco.
export async function planMigration(db) {
  const groupsCol = db.collection('grupos');
  const linksCol = db.collection('grupos_usuario');
  const usersCol = db.collection('usuario');

  const newCodes = NEW_GROUPS.map((g) => g.cod_grupo);
  const existingNewGroups = await groupsCol.find({ cod_grupo: { $in: newCodes } }).project({ _id: 1, cod_grupo: 1 }).toArray();
  const groupIdByCode = new Map(existingNewGroups.map((g) => [codeOf(g), g._id]));
  const groupsToCreate = NEW_GROUPS.filter((g) => !groupIdByCode.has(g.cod_grupo));
  const sampleGroup = await groupsCol.findOne({});
  const sampleLink = await linksCol.findOne({});

  const candidateUsers = await usersCol.find({ ativo: { $in: ['S', true] }, admin: { $ne: 'S' } })
    .project({ _id: 1, telefone: 1, funcao: 1 }).toArray();
  const usersWithPhone = candidateUsers.filter((u) => onlyDigits(u.telefone).length >= 8);
  const userIds = usersWithPhone.map((u) => u._id);

  const links = userIds.length
    ? await linksCol.find({ id_usuario: { $in: userIds } }).project({ id_usuario: 1, id_grupo: 1 }).toArray()
    : [];
  const linkedGroupDocs = links.length
    ? await groupsCol.find({ _id: { $in: links.map((l) => l.id_grupo) } }).project({ _id: 1, cod_grupo: 1 }).toArray()
    : [];
  const codeById = new Map(linkedGroupDocs.map((g) => [String(g._id), codeOf(g)]));
  const codesByUser = new Map();
  for (const link of links) {
    const code = codeById.get(String(link.id_grupo));
    if (!code) continue;
    const set = codesByUser.get(String(link.id_usuario)) ?? new Set();
    set.add(code);
    codesByUser.set(String(link.id_usuario), set);
  }

  const existingBotGroupIds = [...groupIdByCode.values()];
  const existingBotLinks = existingBotGroupIds.length
    ? await linksCol.find({ id_grupo: { $in: existingBotGroupIds } }).project({ id_usuario: 1, id_grupo: 1 }).toArray()
    : [];
  const existingLinkPairs = new Set(existingBotLinks.map((l) => `${String(l.id_usuario)}:${String(l.id_grupo)}`));

  const linksToCreate = [];
  for (const user of usersWithPhone) {
    const codes = codesByUser.get(String(user._id)) ?? new Set();
    const isClinical = CLINICAL_SCREEN_GROUPS.some((c) => codes.has(c));
    const isFinance = codes.has('financeiro') || String(user.funcao ?? '').trim().toLowerCase() === 'diretor financeiro';
    if (!isClinical && !isFinance) continue;
    const wanted = ['bot_whatsapp'];
    if (isClinical) wanted.push('bot_medicao');
    if (isFinance) wanted.push('bot_financeiro');
    for (const code of wanted) {
      const groupId = groupIdByCode.get(code);
      const pairKey = groupId ? `${String(user._id)}:${String(groupId)}` : null;
      if (pairKey && existingLinkPairs.has(pairKey)) continue;
      linksToCreate.push({ userId: user._id, code });
      if (pairKey) existingLinkPairs.add(pairKey);
    }
  }

  return { groupsToCreate, groupIdByCode, sampleGroup, sampleLink, linksToCreate };
}

// Aplica o plano: cria os grupos que faltam e os vínculos que faltam.
export async function applyMigration(db, plan) {
  const groupsCol = db.collection('grupos');
  const linksCol = db.collection('grupos_usuario');
  let groupsCreated = 0;
  for (const group of plan.groupsToCreate) {
    const doc = buildGroupDoc(plan.sampleGroup, group.cod_grupo, group.label);
    const result = await groupsCol.insertOne(doc);
    plan.groupIdByCode.set(group.cod_grupo, result.insertedId);
    groupsCreated += 1;
  }
  const docsToInsert = plan.linksToCreate.map((entry) =>
    buildLinkDoc(plan.sampleLink, entry.userId, plan.groupIdByCode.get(entry.code)),
  );
  if (docsToInsert.length) await linksCol.insertMany(docsToInsert);
  return { groupsCreated, linksCreated: docsToInsert.length };
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
    let groupsCreated = 0;
    let linksCreated = 0;
    if (apply) {
      const result = await applyMigration(db, plan);
      groupsCreated = result.groupsCreated;
      linksCreated = result.linksCreated;
    }
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      groupsExisting: NEW_GROUPS.length - plan.groupsToCreate.length,
      groupsToCreate: apply ? 0 : plan.groupsToCreate.length,
      groupsCreated,
      linksToCreate: apply ? 0 : plan.linksToCreate.length,
      linksCreated,
    }, null, 2));
  } finally {
    await client.close();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    console.error('Erro na migracao:', error.message);
    process.exitCode = 1;
  });
}
