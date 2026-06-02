import cron from 'node-cron';
import type { Application } from 'express';
import { sendMessage, sendSurvey } from '../api/Whatsapp.js';
import { findElimAusenteService } from '../services/ElimAusenteService';
import { findSemEvolucao7dService } from '../services/FindSemEvolucao7dService';
import { buildSegundaFeiraMensagem } from '../services/SegundaFeiraBomDiaService';
import { buildPendenciasAdmMensagem } from '../services/PendenciasAdmService';
import { buildFeridasAbertasMensagem } from '../services/FeridasAbertasService';
import { gerarTitulosRecorrenciaService } from '../services/GerarTitulosRecorrenciaService';
import { buildFolhaPontoAvisoMensagem, ehDiaDeEnviarAvisoFolha } from '../services/FolhaPontoAvisoService';
import formatarData from '../utils/funcoes/formatarData';
import formatarNome from '../utils/funcoes/formatarNome';

function fmtDate(d: Date | string): string {
  const dt = new Date(d);
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(dt);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  return `${get('day')}/${get('month')}/${get('year')} - ${get('hour')}:${get('minute')}`;
}

/**
 * Inicializa todos os cron jobs.
 * Requer que app.locals.db esteja definido antes de chamar.
 */
export default function initCronJobs(app: Application): void {
  const db = app.locals['db'];
  if (!db) throw new Error('Você precisa chamar connect() e atribuir app.locals.db antes de initCronJobs');

  // 1) Bom dia de segunda-feira às 08:00 para o Grupão
  cron.schedule(
    '0 8 * * 1',
    async () => {
      try {
        const msg = await buildSegundaFeiraMensagem(db);
        await sendMessage(process.env.WPP_GROUP_GRUPAO!, msg);
        console.log('✅ [Segunda] Bom dia enviado ao Grupão');
      } catch (err) {
        console.error('❌ Erro no cron bom dia segunda:', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 2) Monitoramento de feridas abertas — segunda-feira às 08:30
  cron.schedule(
    '0 14 * * 1',
    async () => {
      try {
        const msg = await buildFeridasAbertasMensagem(db);
        await sendMessage(process.env.WPP_GROUP_TECNICOS!, msg);
        console.log('✅ [Feridas] Monitoramento enviado');
      } catch (err) {
        console.error('❌ Erro no cron feridas:', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 3) Pendências ADM seg-sex às 10h
  cron.schedule(
    '0 10 * * 1-5',
    async () => {
      try {
        const msg = await buildPendenciasAdmMensagem(db);
        await sendMessage(process.env.WPP_GROUP_ADM!, msg);
        console.log('✅ [Pendências ADM] Enviado');
      } catch (err) {
        console.error('❌ Erro no cron pendências ADM:', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 3) Survey de poker toda quinta-feira às 10h (horário de SP)
  cron.schedule(
    '0 10 * * 4',
    async () => {
      try {
        await sendSurvey(process.env.POKERGROUP!, 'Hoje tem poker??', ['Sim', 'Não']);
        console.log('📋 [Survey] Enviado com sucesso');
      } catch (err) {
        console.error('❌ Erro ao enviar survey:', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 2) Consulta de residentes às 08:00 (horário de SP)
  cron.schedule(
    '0 8 * * *',
    async () => {
      try {
        const resultados = await findElimAusenteService(db);
        console.log('📋 [08:00] Residentes com eliminações ausentes:', resultados);
      } catch (err) {
        console.error('❌ Erro no cronjob residentes (08:00):', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 3) Alerta de eliminação intestinal ausente às 08:35 (horário de SP)
  cron.schedule(
    '35 08 * * *',
    async () => {
      try {
        const resultados = await findElimAusenteService(db);
        const wppGroupId = process.env.WPP_GROUP_TECNICOS!;

        if (resultados.length > 0) {
          const linha = resultados.map(resultado => {
            const datas = resultado.ultimasAnotacoes
              .map(data => `  • ${fmtDate(data)}`)
              .join('\n');
            const aviso = resultado.consecutiveCount > 4
              ? ` *(${resultado.consecutiveCount} registros consecutivos)*`
              : '';
            return `👴👵 ${resultado.nome}${aviso}:\n${datas}`;
          }).join('\n\n');

          const mensagem = [
            '🤖 *Alerta de Saúde*',
            '',
            'O robô identificou idosos com *eliminação intestinal ausente*',
            'nos últimos registros consecutivos:',
            '',
            linha,
            '',
            'Por favor, verifique o atendimento de cada um.',
            '👍',
          ].join('\n');

          await sendMessage(wppGroupId, mensagem);
          console.log('✅ Alerta enviado ao WhatsApp');
        } else {
          console.log('🔍 Nenhum residente com registros ausentes hoje.');
        }
      } catch (err) {
        console.error('❌ Erro no cronjob residentes (08:35):', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // Geração de títulos de recorrências — todo dia às 06:00 (SP)
  cron.schedule(
    '0 6 * * *',
    async () => {
      try {
        const { criados, ignorados } = await gerarTitulosRecorrenciaService(db);
        console.log(`✅ [Recorrências] ${criados} título(s) criado(s), ${ignorados} já existia(m)`);
      } catch (err) {
        console.error('❌ Erro no cron de recorrências:', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // Aviso folha de ponto — dias úteis 2 a 5 do mês às 08:00 (referente ao mês anterior)
  cron.schedule(
    '0 8 * * *',
    async () => {
      try {
        if (!ehDiaDeEnviarAvisoFolha()) return;
        const msg = await buildFolhaPontoAvisoMensagem(db);
        if (!msg) {
          console.log('✅ [Folha de Ponto] Todos os funcionários enviaram.');
          return;
        }
        await sendMessage(process.env.WPP_GROUP_GRUPAO!, msg);
        console.log('✅ [Folha de Ponto] Aviso de pendências enviado ao Grupão');
      } catch (err) {
        console.error('❌ Erro no cron folha de ponto:', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  // 4) Alerta de evolução >7 dias às 09:00 (horário de SP)
  cron.schedule(
    '0 9 * * *',
    async () => {
      try {
        const resultados = await findSemEvolucao7dService(db);
        const wppGroupId = process.env.WPP_GROUP_MULTIDISCIPLINAR!;

        if (!resultados || resultados.length === 0) {
          console.log('🔍 Nenhuma área com residentes >7 dias sem evolução.');
          return;
        }

        const blocos = resultados.map(({ area, residentes }) => {
          const linhas = residentes.map(r =>
            `  • ${formatarNome(r.nome)} — últ.: ${formatarData(r.ultimaEvolucao)} (${r.daysSince}d)`
          ).join('\n');
          return `*${area}*\n${linhas}`;
        }).join('\n\n');

        const mensagem = [
          '🤖 *Alerta de Evolução*',
          '',
          'Idosos sem evolução há *mais de 7 dias* (por área):',
          '',
          blocos,
          '',
          'Por favor, realizar as evoluções pendentes. 👍',
        ].join('\n');

        await sendMessage(wppGroupId, mensagem);
        console.log('✅ Alerta sem evolução enviado ao WhatsApp');
      } catch (err) {
        console.error('❌ Erro no cronjob de evolução (>7d):', err);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );
}
