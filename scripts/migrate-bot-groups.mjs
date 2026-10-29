// Migração dos grupos do bot do WhatsApp (bot_whatsapp/bot_medicao/bot_financeiro).
// O Dockerfile da API não copia scripts/ para a imagem (só server.ts e src/ -> dist/),
// então o script é executado via stdin, lido pelo cwd /app (onde 'mongodb' já está instalado):
//   docker exec -i lfz-api node --input-type=module -            < scripts/migrate-bot-groups.mjs   (dry-run, só conta)
//   docker exec -i lfz-api node --input-type=module - --apply    < scripts/migrate-bot-groups.mjs   (grava)
// Lê MONGODB_URI/MONGODB_DBNAME do ambiente do container.
// Nunca imprime nome/telefone de usuário; só contagens e nomes/tipos de campo.
import { ObjectId } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const NEW_GROUPS = [
  { cod_grupo: 'bot_whatsapp', label: 'Bot WhatsApp' },
  { cod_grupo: 'bot_medicao', label: 'Bot WhatsApp - Medicao' },
  { cod_grupo: 'bot_financeiro', label: 'Bot WhatsApp - Financeiro' },
];
const CLINICAL_SCREEN_GROUPS = ['medicina', 'equipe_enfermagem', 'coordenacao'];
const onlyDigits = (value) => String(value ?? '').replace(/\D/g, '');
const codeOf = (doc) => String(doc?.cod_grupo ?? '').trim().toLowerCase();

// Variantes de um id para casar com `$in` tanto se o campo foi gravado como string
// quanto como ObjectId (grupos_usuario tem os dois formatos em produção).
function idVariants(id) {
  const str = String(id);
  const variants = [str];
  if (ObjectId.isValid(str)) variants.push(new ObjectId(str));
  return variants;
}

function valueKind(value) {
  if (value instanceof ObjectId) return 'objectid';
  if (typeof value === 'string') return 'string';
  return 'other';
}
function castId(kind, id) {
  if (kind === 'string') return String(id);
  if (kind === 'objectid') return id instanceof ObjectId ? id : (ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : id);
  return id;
}

function describeFields(doc) {
  if (!doc) return null;
  const fields = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id') continue;
    fields[key] = value instanceof ObjectId ? 'ObjectId' : value instanceof Date ? 'Date' : typeof value;
  }
  return fields;
}

const GROUP_LABEL_FIELD = /nome|descric|label/i;
const TIMESTAMP_FIELD = /^(created_at|updated_at|criado_em|atualizado_em|data_criacao|data_atualizacao)$/i;

// Só copia cod_grupo + um campo de rótulo (nome/descrição) + timestamps do grupo
// de exemplo. Nunca copia listas de telas/permissões/membros nem qualquer outro
// campo desconhecido, para não herdar acesso do portal.
export function buildGroupDoc(sampleDoc, codGrupo, label) {
  const doc = { cod_grupo: codGrupo };
  if (sampleDoc) {
    for (const [key, value] of Object.entries(sampleDoc)) {
      if (key === '_id' || key === 'cod_grupo') continue;
      if (GROUP_LABEL_FIELD.test(key) && typeof value === 'string') doc[key] = label;
      else if (value instanceof Date || TIMESTAMP_FIELD.test(key)) doc[key] = new Date();
    }
  }
  return doc;
}

// Só copia id_usuario, id_grupo e timestamps do vínculo de exemplo (no mesmo tipo
// string/ObjectId do vínculo existente). Nenhum outro campo é copiado.
export function buildLinkDoc(sampleDoc, userId, groupId) {
  const userKind = sampleDoc && 'id_usuario' in sampleDoc ? valueKind(sampleDoc.id_usuario) : 'objectid';
  const groupKind = sampleDoc && 'id_grupo' in sampleDoc ? valueKind(sampleDoc.id_grupo) : 'objectid';
  const doc = { id_usuario: castId(userKind, userId), id_grupo: castId(groupKind, groupId) };
  if (sampleDoc) {
    for (const [key, value] of Object.entries(sampleDoc)) {
      if (key === '_id' || key === 'id_usuario' || key === 'id_grupo') continue;
      if (value instanceof Date || TIMESTAMP_FIELD.test(key)) doc[key] = new Date();
    }
  }
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
  const userIdVariants = usersWithPhone.flatMap((u) => idVariants(u._id));

  const links = userIdVariants.length
    ? await linksCol.find({ id_usuario: { $in: userIdVariants } }).project({ id_usuario: 1, id_grupo: 1 }).toArray()
    : [];
  const linkedGroupObjectIds = [...new Set(links.map((l) => String(l.id_grupo)))]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  const linkedGroupDocs = linkedGroupObjectIds.length
    ? await groupsCol.find({ _id: { $in: linkedGroupObjectIds } }).project({ _id: 1, cod_grupo: 1 }).toArray()
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
  const existingBotGroupVariants = existingBotGroupIds.flatMap((id) => idVariants(id));
  const existingBotLinks = existingBotGroupVariants.length
    ? await linksCol.find({ id_grupo: { $in: existingBotGroupVariants } }).project({ id_usuario: 1, id_grupo: 1 }).toArray()
    : [];
  const existingLinkPairs = new Set(existingBotLinks.map((l) => `${String(l.id_usuario)}:${String(l.id_grupo)}`));

  const linksToCreate = [];
  for (const user of usersWithPhone) {
    // codesByUser é indexado pela forma string do _id (ver loop acima); _id de
    // usuario é sempre ObjectId, então String(user._id) sempre casa com a chave.
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

  const linksByGroup = Object.fromEntries(NEW_GROUPS.map((g) => [g.cod_grupo, linksToCreate.filter((l) => l.code === g.cod_grupo).length]));

  return {
    groupsToCreate,
    groupIdByCode,
    sampleGroup,
    sampleLink,
    linksToCreate,
    linksByGroup,
    sampleGroupFields: describeFields(sampleGroup),
    sampleLinkFields: describeFields(sampleLink),
  };
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
      linksByGroup: plan.linksByGroup,
      sampleGroupFields: plan.sampleGroupFields,
      sampleLinkFields: plan.sampleLinkFields,
    }, null, 2));
  } finally {
    await client.close();
  }
}

// Roda main() quando executado direto (node scripts/migrate-bot-groups.mjs) OU
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
