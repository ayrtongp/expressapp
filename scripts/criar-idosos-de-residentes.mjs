// Cria cadastro em Idosos (patient + idoso_detalhes) para residentes que só
// existem na ficha antiga (collection `residentes`), sem tocar em nenhum dado
// existente. ADR 0005, etapa B — entrega para revisão; a execução em produção
// só acontece depois da aprovação do Líder Técnico + Ayrton.
//
// O que grava (somente com --apply), por alvo:
//   1) `patient` no formato atual (mesmo shape de C_idosoDetalhes), ACRESCENTANDO
//      `residente_id` = `residentes._id` como ponte legada (mesma forma dos 47
//      patients já existentes). Não grava `usuario_id`, nem CPF/telefone/endereço.
//   2) `idoso_detalhes` com `patient_id` e `status` derivado de `is_ativo`.
//   3) `patient.idoso_detalhes_id` = id do idoso_detalhes criado.
//
// `admissao.modalidadePrincipal` fica AUSENTE de propósito: `residentes` não tem
// campo equivalente (nem `modalidade`, nem `tipoVaga`/`tipo_vaga`; conferido no
// tipo `Residente`, no formulário legado e no `ResidentesController`). Não se
// inventa default `residencia_fixa` — o dry-run lista a pendência por alvo para
// o operador preencher na ficha depois.
// NUNCA cria `usuario`, NUNCA altera `residentes`, prescrições, sinais vitais,
// anotações ou qualquer outro documento.
//
// Idempotente: se já existe `patient` com aquele `residente_id`, o alvo é pulado
// e apenas relatado. Se o nome casar 0 ou mais de 1 residente, ABORTA sem gravar
// nada. Nomes são a lista explícita abaixo; "Idoso teste" fica de fora.
//
// Execução (o Dockerfile da API não copia scripts/ para a imagem, então roda
// via stdin, como diag-idosos.mjs/migrate-clinico.mjs):
//   docker exec -i lfz-api node --input-type=module -           < scripts/criar-idosos-de-residentes.mjs   # dry-run
//   docker exec -i lfz-api node --input-type=module - --apply   < scripts/criar-idosos-de-residentes.mjs   # grava
// Lê MONGODB_URI/MONGODB_DBNAME do ambiente do container.
//
// Saída: nomes e contagens. Nunca CPF, telefone, endereço ou data de nascimento.
//
// Retorno (rollback) — apagar APENAS os 4 documentos criados, por _id, na ordem
// idoso_detalhes → patient (o `--apply` imprime os ids):
//   db.idoso_detalhes.deleteMany({ _id: { $in: [IdosoA, IdosoB] } })
//   db.patient.deleteMany({ _id: { $in: [PatientA, PatientB] } })
// Nada mais aponta para eles no momento da criação.
import { ObjectId } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Lista explícita (nome exato em `residentes.nome`). Não adicionar "Idoso teste":
// decisão do Ayrton foi deixá-lo parado (inativo, sem histórico clínico).
export const ALVOS = [
  'Memésio Joaquim dos Santos',
  'Mariano Jorge Furtado Ramos',
];

export const CREATED_BY = 'script:criar-idosos-de-residentes';

const hex = (value) => (value === null || value === undefined ? '' : String(value));

// Aceita o id gravado como string ou como ObjectId (os 47 patients atuais usam
// string; a rota do portal testa os dois formatos).
function idVariants(id) {
  const str = hex(id);
  const variants = [str];
  if (/^[a-fA-F0-9]{24}$/.test(str)) {
    try {
      variants.push(new ObjectId(str));
    } catch {
      /* id inválido: fica só a string */
    }
  }
  return variants;
}

// `residentes` guarda o nome completo em `nome` (sem campo sobrenome).
// Mesmo shape dos 47 patients: given = primeiro token, family = restante;
// `display_name` preserva o nome completo exato.
export function splitName(nomeCompleto) {
  const partes = String(nomeCompleto ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return { given: '', family: '' };
  if (partes.length === 1) return { given: partes[0], family: '' };
  return { given: partes[0], family: partes.slice(1).join(' ') };
}

export function buildPatientDoc(residente, patientId, now) {
  const nomeCompleto = String(residente.nome ?? '').trim();
  const { given, family } = splitName(nomeCompleto);
  const identifier = [];
  if (residente.numProntuario) {
    identifier.push({ system: 'prontuario', value: String(residente.numProntuario) });
  }
  return {
    _id: patientId,
    resourceType: 'Patient',
    identifier,
    name: [{
      use: 'official',
      family,
      given: [given],
      text: nomeCompleto,
    }],
    gender: residente.genero || 'unknown',
    birthDate: residente.data_nascimento || '',
    telecom: [],
    address: [],
    contact: [],
    extension: {},
    active: residente.is_ativo === 'S',
    // Ponte legada (mesmo formato dos patients criados por migrate-patients).
    residente_id: hex(residente._id),
    // Denormalizados (compat com o pipeline de C_idosoDetalhes).
    given_name: given,
    family_name: family,
    display_name: nomeCompleto,
    birth_date: residente.data_nascimento || '',
    createdAt: now,
    updatedAt: now,
  };
}

export function buildIdosoDoc(residente, patientId, idosoId, now) {
  return {
    _id: idosoId,
    patient_id: hex(patientId),
    status: residente.is_ativo === 'S' ? 'ativo' : 'inativo',
    // Só valores que já existem em `residentes`; nada é inferido.
    admissao: {
      dataEntrada: residente.data_entrada || '',
      numProntuario: residente.numProntuario || '',
    },
    responsavel: {},
    composicaoFamiliar: [],
    historico: {},
    documentos: {},
    observacoes: '',
    createdBy: CREATED_BY,
    createdAt: now,
    updatedAt: now,
  };
}

// Campos que o dry-run mostra ao operador (sem valores pessoais).
export const PATIENT_FIELDS = [
  'resourceType', 'identifier', 'name', 'gender', 'birthDate', 'telecom',
  'address', 'contact', 'extension', 'active', 'residente_id', 'given_name',
  'family_name', 'display_name', 'birth_date', 'createdAt', 'updatedAt',
];
export const IDOSO_FIELDS = [
  'patient_id', 'status', 'admissao', 'responsavel', 'composicaoFamiliar',
  'historico', 'documentos', 'observacoes', 'createdBy', 'createdAt', 'updatedAt',
];

// Lê o estado atual e monta o plano. Nunca escreve.
export async function planCreation(db, alvos = ALVOS) {
  const residentesCol = db.collection('residentes');
  const patientCol = db.collection('patient');
  const alvosPlano = [];
  const erros = [];

  for (const nome of alvos) {
    const encontrados = await residentesCol
      .find({ nome })
      .project({
        _id: 1,
        nome: 1,
        is_ativo: 1,
        data_nascimento: 1,
        genero: 1,
        data_entrada: 1,
        numProntuario: 1,
      })
      .toArray();

    if (encontrados.length === 0) {
      erros.push(`${nome}: nenhum residente com esse nome exato.`);
      alvosPlano.push({ nome, status: 'abortar', motivo: 'nome não encontrado' });
      continue;
    }
    if (encontrados.length > 1) {
      erros.push(`${nome}: ${encontrados.length} residentes com esse nome exato (ambíguo).`);
      alvosPlano.push({ nome, status: 'abortar', motivo: 'nome ambíguo' });
      continue;
    }

    const residente = encontrados[0];
    const residenteId = hex(residente._id);
    const patientExistente = await patientCol.findOne({
      residente_id: { $in: idVariants(residente._id) },
    });

    if (patientExistente) {
      alvosPlano.push({
        nome,
        residenteId,
        isAtivo: residente.is_ativo === 'S',
        status: 'pular',
        motivo: 'já existe patient para este residente_id',
        patientExistenteId: hex(patientExistente._id),
      });
      continue;
    }

    const patientId = new ObjectId();
    const idosoId = new ObjectId();
    const now = new Date().toISOString();
    const patientDoc = buildPatientDoc(residente, patientId, now);
    const idosoDoc = buildIdosoDoc(residente, patientId, idosoId, now);

    // Pendências conhecidas do cadastro novo, mostradas antes do --apply.
    // Nada é inferido/preenchido: o operador ajusta na ficha.
    const pendencias = [];
    if (!idosoDoc.admissao?.modalidadePrincipal) {
      pendencias.push('modalidadePrincipal em branco — preencher na ficha');
    }

    alvosPlano.push({
      nome,
      residenteId,
      isAtivo: residente.is_ativo === 'S',
      status: 'criar',
      patientIdPlanejado: hex(patientId),
      idosoDetalhesIdPlanejado: hex(idosoId),
      camposPatient: PATIENT_FIELDS,
      camposIdoso: IDOSO_FIELDS,
      pendencias,
      // Documentos completos para o apply; nunca impressos crus (têm nome/nascimento).
      _residente: residente,
      _patient: patientDoc,
      _idoso: idosoDoc,
    });
  }

  return { alvos: alvosPlano, erros };
}

export function summarizePlan(plan) {
  const resumo = { aCriar: 0, pulados: 0, abortados: 0 };
  for (const alvo of plan.alvos) {
    if (alvo.status === 'criar') resumo.aCriar += 1;
    else if (alvo.status === 'pular') resumo.pulados += 1;
    else resumo.abortados += 1;
  }
  return resumo;
}

// Grava o plano. Aborta inteiro se o plano tiver qualquer erro/abort.
export async function applyCreation(db, plan) {
  const criados = [];
  const falhas = [];
  if (plan.erros.length > 0) {
    return { criados, falhas, abortado: true };
  }

  const patientCol = db.collection('patient');
  const idosoCol = db.collection('idoso_detalhes');

  for (const alvo of plan.alvos) {
    if (alvo.status !== 'criar') continue;
    try {
      // Rechecagem final, para o caso de o banco mudar entre o plano e o insert.
      const existente = await patientCol.findOne({
        residente_id: { $in: idVariants(alvo._residente._id) },
      });
      if (existente) {
        falhas.push(`${alvo.nome}: patient passou a existir durante a execução; não gravado.`);
        continue;
      }

      await patientCol.insertOne(alvo._patient);
      let idosoInserido = false;
      try {
        await idosoCol.insertOne(alvo._idoso);
        idosoInserido = true;
        await patientCol.updateOne(
          { _id: alvo._patient._id },
          { $set: { idoso_detalhes_id: hex(alvo._idoso._id) } },
        );
      } catch (error) {
        // Desfaz o que já foi inserido, na ordem inversa (idoso_detalhes → patient),
        // para não deixar idoso_detalhes órfão. Sem isso, a próxima execução não
        // pularia (o patient sumiu) e criaria um segundo idoso_detalhes.
        const limpeza = [];
        if (idosoInserido) {
          try {
            await idosoCol.deleteOne({ _id: alvo._idoso._id });
          } catch (cleanupError) {
            limpeza.push(`idoso_detalhes ${hex(alvo._idoso._id)}: ${cleanupError?.message ?? 'erro'}`);
          }
        }
        try {
          await patientCol.deleteOne({ _id: alvo._patient._id });
        } catch (cleanupError) {
          limpeza.push(`patient ${hex(alvo._patient._id)}: ${cleanupError?.message ?? 'erro'}`);
        }
        if (limpeza.length > 0) {
          throw new Error(`${error?.message ?? 'erro desconhecido'}; limpeza incompleta: ${limpeza.join('; ')}`);
        }
        throw error;
      }

      criados.push({
        nome: alvo.nome,
        patientId: hex(alvo._patient._id),
        idosoDetalhesId: hex(alvo._idoso._id),
      });
    } catch (error) {
      falhas.push(`${alvo.nome}: ${error?.message ?? 'erro desconhecido'}`);
    }
  }

  return { criados, falhas, abortado: false };
}

function publicPlan(plan) {
  return {
    alvos: plan.alvos.map((alvo) => ({
      nome: alvo.nome,
      residenteId: alvo.residenteId,
      isAtivo: alvo.isAtivo,
      status: alvo.status,
      motivo: alvo.motivo,
      patientExistenteId: alvo.patientExistenteId,
      patientIdPlanejado: alvo.patientIdPlanejado,
      idosoDetalhesIdPlanejado: alvo.idosoDetalhesIdPlanejado,
      camposPatient: alvo.camposPatient,
      camposIdoso: alvo.camposIdoso,
      pendencias: alvo.pendencias,
    })),
    resumo: summarizePlan(plan),
    erros: plan.erros,
  };
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
    const plan = await planCreation(db);

    if (!apply) {
      console.log(JSON.stringify({
        mode: 'dry-run',
        ...publicPlan(plan),
        aviso: 'Nada foi gravado. Use --apply apos revisao.',
      }, null, 2));
      return;
    }

    if (plan.erros.length > 0) {
      console.log(JSON.stringify({
        mode: 'apply',
        ...publicPlan(plan),
        aviso: 'Plano com erro/ambiguidade: nada foi gravado.',
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    const resultado = await applyCreation(db, plan);
    console.log(JSON.stringify({
      mode: 'apply',
      ...publicPlan(plan),
      criados: resultado.criados,
      falhas: resultado.falhas,
      rollback: {
        passos: [
          'conferir os ids abaixo',
          'db.idoso_detalhes.deleteMany({ _id: { $in: [idosoA, idosoB] } })',
          'db.patient.deleteMany({ _id: { $in: [patientA, patientB] } })',
        ],
        idosoDetalhesIds: resultado.criados.map((c) => c.idosoDetalhesId),
        patientIds: resultado.criados.map((c) => c.patientId),
      },
    }, null, 2));
    if (resultado.falhas.length > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

// Roda main() quando executado direto (node scripts/criar-idosos-de-residentes.mjs)
// OU quando lido via stdin (`node --input-type=module -`, onde argv[1] é '-').
const invokedPath = process.argv[1];
const invokedDirectly = invokedPath === '-' || invokedPath === undefined
  || fileURLToPath(import.meta.url) === resolve(invokedPath);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('Erro ao criar idosos:', error.message);
    process.exitCode = 1;
  });
}
