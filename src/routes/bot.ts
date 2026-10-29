import { Router, type Request } from 'express';
import { ObjectId } from 'mongodb';
import { requireBotToken } from '../middleware/botAuth';
const router = Router();
const CONTEXT_GROUPS = new Set(['medicina', 'equipe_enfermagem', 'coordenacao', 'financeiro']);
const MEASUREMENT_GROUPS = new Set(['medicina', 'equipe_enfermagem', 'coordenacao']);
type SingleMeasurementType = { code: string; label: string; unit: string; min: number; max: number; integer?: boolean };
const SINGLE_VALUE_TYPES: Record<string, SingleMeasurementType> = {
  glicemia: { code: 'GLUCOSE', label: 'Glicemia', unit: 'mg/dL', min: 20, max: 700 },
  temperatura: { code: 'TEMP', label: 'Temperatura', unit: '°C', min: 30, max: 43 },
  saturacao: { code: 'SPO2', label: 'Saturação O₂', unit: '%', min: 50, max: 100 },
  frequencia_cardiaca: { code: 'HR', label: 'Freq. Cardíaca', unit: 'bpm', min: 20, max: 300 },
  frequencia_respiratoria: { code: 'RR', label: 'Freq. Respiratória', unit: 'ipm', min: 4, max: 60 },
  peso: { code: 'WEIGHT', label: 'Peso', unit: 'kg', min: 20, max: 300 },
  dor: { code: 'PAIN_SCORE', label: 'Escala de Dor (EVA)', unit: '/10', min: 0, max: 10, integer: true },
  diurese: { code: 'DIURESIS', label: 'Diurese', unit: 'ml', min: 0, max: 5000, integer: true },
};
const MEASUREMENT_TYPES = new Set(['pressao', ...Object.keys(SINGLE_VALUE_TYPES)]);
const dbOf = (req: Request): any => req.app.locals['db'];
const onlyDigits = (value: string): string => value.replace(/\D/g, '');
export async function ensureBotIndexes(db: any): Promise<void> {
  await db.collection('measurement_session').createIndex(
    { source_reference: 1 },
    { unique: true, partialFilterExpression: { source_reference: { $type: 'string' } } },
  );
}
async function groupsForUser(db: any, userId: string): Promise<string[]> {
  const userIds: any[] = [userId];
  if (ObjectId.isValid(userId)) userIds.push(new ObjectId(userId));
  const relations = await db.collection('grupos_usuario')
    .find({ id_usuario: { $in: userIds } })
    .project({ id_grupo: 1 }).toArray();
  const ids = relations.map((row: any) => String(row.id_grupo))
    .filter((id: string) => ObjectId.isValid(id)).map((id: string) => new ObjectId(id));
  if (!ids.length) return [];
  const groups = await db.collection('grupos').find({ _id: { $in: ids } })
    .project({ cod_grupo: 1 }).toArray();
  return groups.map((row: any) => String(row.cod_grupo ?? '').trim().toLowerCase()).filter(Boolean);
}
async function employeeContext(db: any, phone: string): Promise<{ userId: string; employeeName: string; permissions: Record<string, string[]> } | null> {
  const users = await db.collection('usuario').find({ ativo: { $in: ['S', true] } })
    .project({ nome: 1, sobrenome: 1, telefone: 1, ativo: 1, admin: 1, funcao: 1 }).toArray();
  const user = users.find((row: any) => onlyDigits(String(row.telefone ?? '')) === onlyDigits(phone));
  if (!user) return null;
  const userId = String(user._id);
  const groups = await groupsForUser(db, userId);
  const isAdmin = String(user.admin ?? '').trim().toUpperCase() === 'S';
  const isFinanceDirector = String(user.funcao ?? '').trim().toLowerCase() === 'diretor financeiro';
  if (!isAdmin && !isFinanceDirector && !groups.some((group) => CONTEXT_GROUPS.has(group))) return null;
  const permissions: Record<string, string[]> = {};
  if (groups.some((group) => MEASUREMENT_GROUPS.has(group))) permissions.medicao_avulsa = ['criar'];
  if (isAdmin) permissions.usuarios = ['gerenciar'];
  if (isAdmin || isFinanceDirector || groups.includes('financeiro')) permissions.funcoes_financeiras = ['gerenciar'];
  return { userId, employeeName: [user.nome, user.sobrenome].filter(Boolean).join(' '), permissions };
}
async function authorizedEmployee(db: any, userId: string): Promise<boolean> {
  if (!ObjectId.isValid(userId)) return false;
  const user = await db.collection('usuario').findOne({ _id: new ObjectId(userId), ativo: { $in: ['S', true] } }, { projection: { _id: 1, admin: 1, funcao: 1 } });
  if (!user) return false;
  const groups = await groupsForUser(db, userId);
  return groups.some((group) => MEASUREMENT_GROUPS.has(group));
}
router.use(requireBotToken);
router.get('/context', async (req, res) => {
  const phone = typeof req.query.phone === 'string' ? req.query.phone : '';
  if (onlyDigits(phone).length < 8) return res.status(400).json({ ok: false, error: 'phone invalido.' });
  try {
    const context = await employeeContext(dbOf(req), phone);
    return res.status(200).json(context ? { employeeId: context.userId, employeeName: context.employeeName, permissions: context.permissions } : null);
  } catch { return res.status(500).json({ ok: false, error: 'Erro interno.' }); }
});
router.get('/residents', async (req, res) => {
  if (Array.isArray(req.query.query)) return res.status(400).json({ ok: false, error: 'query invalida.' });
  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
  const offsetRaw = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 50;
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  try {
    const filter: any = { active: true };
    if (query) filter.display_name = { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const rows = await dbOf(req).collection('patient').find(filter).project({ _id: 1, display_name: 1 }).sort({ display_name: 1 }).skip(offset).limit(limit).toArray();
    return res.status(200).json(rows.map((row: any) => ({ id: String(row._id), name: String(row.display_name) })));
  } catch { return res.status(500).json({ ok: false, error: 'Erro interno.' }); }
});
router.post('/measurements', async (req, res) => {
  const body = req.body ?? {};
  const { employeeId, residentId, type, value, measuredAt } = body;
  if (!ObjectId.isValid(String(employeeId)) || !ObjectId.isValid(String(residentId)) || !MEASUREMENT_TYPES.has(type) || typeof value !== 'string' || !value.trim() || typeof measuredAt !== 'string' || Number.isNaN(Date.parse(measuredAt))) return res.status(400).json({ ok: false, error: 'Payload invalido.' });
  try {
    const db = dbOf(req);
    if (!(await authorizedEmployee(db, String(employeeId)))) return res.status(403).json({ ok: false, error: 'Permissao insuficiente.' });
    const [patient, user] = await Promise.all([
      db.collection('patient').findOne({ _id: new ObjectId(residentId), active: true }),
      db.collection('usuario').findOne({ _id: new ObjectId(employeeId), ativo: { $in: ['S', true] } }, { projection: { nome: 1, sobrenome: 1 } }),
    ]);
    if (!patient || !user) return res.status(404).json({ ok: false, error: 'Registro nao encontrado.' });
    const now = new Date().toISOString();
    let entries: { code: string; label: string; unit: string; numeric: number }[];
    if (type === 'pressao') {
      const pressure = value.trim().match(/^(\d{2,3})\s*[/x]\s*(\d{2,3})$/i);
      const sys = pressure ? Number(pressure[1]) : NaN;
      const dia = pressure ? Number(pressure[2]) : NaN;
      if (!pressure || sys < 50 || sys > 250 || dia < 30 || dia > 150) return res.status(400).json({ ok: false, error: 'Valor fora do formato ou limite.' });
      entries = [
        { code: 'BP_SYS', label: 'Pressão Sistólica', unit: 'mmHg', numeric: sys },
        { code: 'BP_DIA', label: 'Pressão Diastólica', unit: 'mmHg', numeric: dia },
      ];
    } else {
      const config = SINGLE_VALUE_TYPES[type];
      const numeric = Number(value.trim().replace(',', '.'));
      if (!Number.isFinite(numeric) || numeric < config.min || numeric > config.max || (config.integer && !Number.isInteger(numeric))) return res.status(400).json({ ok: false, error: 'Valor fora do formato ou limite.' });
      entries = [{ code: config.code, label: config.label, unit: config.unit, numeric }];
    }
    const sessions = db.collection('measurement_session');
    const measurements = db.collection('measurement');
    const codes = entries.map((entry) => entry.code);
    const values = entries.map((entry) => entry.numeric);
    const sourceReference = `bot:${patient._id}:${employeeId}:${measuredAt}:${codes.join(',')}:${values.join(',')}`;
    const session = { patient_id: String(patient._id), patient_name: patient.display_name, measured_at: measuredAt, recorded_by_user_id: String(employeeId), source_type: 'manual', source_reference: sourceReference, status: 'active', recorded_at: now, recorded_by_name: [user.nome, user.sobrenome].filter(Boolean).join(' '), created_at: now, updated_at: now };
    const upserted = await sessions.findOneAndUpdate({ source_reference: sourceReference }, { $setOnInsert: session }, { upsert: true, returnDocument: 'after', includeResultMetadata: true });
    const inserted = upserted.value;
    if (!inserted) throw new Error('Sessao nao criada.');
    const alreadyHadSession = !upserted.lastErrorObject?.upserted;
    if (alreadyHadSession) return res.status(200).json({ id: String(inserted._id), employeeId, residentId, type, value, measuredAt, createdAt: inserted.created_at });
    const docs = entries.map((entry) => ({ type_code: entry.code, type_label: entry.label, value_numeric: entry.numeric, unit: entry.unit, session_id: String(inserted._id), status: 'final', created_at: now, updated_at: now }));
    try { await measurements.insertMany(docs); } catch (error) { await sessions.deleteOne({ _id: inserted._id, source_reference: sourceReference }).catch(() => undefined); throw error; }
    return res.status(201).json({ id: String(inserted._id), employeeId, residentId, type, value, measuredAt, createdAt: now });
  } catch { return res.status(500).json({ ok: false, error: 'Erro interno.' }); }
});
export default router;
