# API interna do bot
Configure `BOT_SERVICE_TOKEN` na API e no bot. Nunca registre ou versione o valor.
Todas as rotas exigem `Authorization: Bearer <BOT_SERVICE_TOKEN>`.
- `GET /api/bot/context?phone=<E164>`: retorna `EmployeeContext` ou `null`. Ver "Quem pode usar o bot" abaixo para a regra completa de autorização.
- `GET /api/bot/residents?query=<texto>` e `GET /api/bot/residents`: retorna `{id,name}[]` de `patient` ativos.
- `POST /api/bot/measurements`: aceita `CreateMeasurementInput`; grava em `measurement_session` e `measurement`, usando `source_type=manual`. É idempotente por paciente, registrador, timestamp e tipo/valor.

  Tipos aceitos (`type` → `type_code`/`type_label` do catálogo `T_measurement.ts`, `unit`, limites de `value`):

  | `type`                     | `type_code`  | `type_label`              | `unit` | limites        | formato            |
  |----------------------------|--------------|----------------------------|--------|----------------|--------------------|
  | `pressao`                  | `BP_SYS`/`BP_DIA` | Pressão Sistólica / Pressão Diastólica | mmHg | sist. 50–250, diast. 30–150 | `NNN/NN` (ex.: `120/80`) |
  | `glicemia`                 | `GLUCOSE`    | Glicemia                   | mg/dL  | 20–700         | numérico           |
  | `temperatura`              | `TEMP`       | Temperatura                | °C     | 30–43          | numérico (decimal) |
  | `saturacao`                | `SPO2`       | Saturação O₂               | %      | 50–100         | numérico           |
  | `frequencia_cardiaca`      | `HR`         | Freq. Cardíaca             | bpm    | 20–300         | numérico           |
  | `frequencia_respiratoria`  | `RR`         | Freq. Respiratória         | ipm    | 4–60           | numérico           |
  | `peso`                     | `WEIGHT`     | Peso                       | kg     | 20–300         | numérico (decimal) |
  | `dor`                      | `PAIN_SCORE` | Escala de Dor (EVA)        | /10    | 0–10           | numérico (inteiro) |
  | `diurese`                  | `DIURESIS`   | Diurese                    | ml     | 0–5000         | numérico (inteiro) |

  Os 4 tipos anteriores (`pressao`, `glicemia`, `temperatura`, `saturacao`) continuam aceitando o mesmo payload; apenas o `type_label` gravado passou a usar o rótulo do catálogo em vez do nome interno do tipo.
Respostas: 401 sem token, 403 token inválido/permissão insuficiente, 400 entrada inválida, 404 registro inexistente e 500 com mensagem genérica.

## Quem pode usar o bot

Decisão de 2026-10-29: o acesso ao bot do WhatsApp passou a depender de grupos dedicados em vez dos grupos de tela do portal. `medicina`, `equipe_enfermagem`, `coordenacao`, `financeiro` e `usuario.funcao="Diretor Financeiro"` não concedem mais nada no bot.

- `usuario.admin='S'` (ativo, telefone cadastrado): acesso total, sem precisar de nenhum grupo — `medicao_avulsa.criar`, `funcoes_financeiras.gerenciar` e `usuarios.gerenciar`.
- Qualquer outro usuário precisa estar no grupo `bot_whatsapp` só para ter contexto no bot (sem ele, `GET /api/bot/context` retorna `null` e o bot trata como número não autorizado).
- Dentro de `bot_whatsapp`, cada comando exige o grupo específico:

  | grupo (`cod_grupo`) | permissão concedida |
  |----------------------|----------------------|
  | `bot_whatsapp`       | pré-requisito para ter contexto; por si só não concede nenhuma capacidade |
  | `bot_medicao`        | `medicao_avulsa.criar` (usado por `POST /api/bot/measurements`) |
  | `bot_financeiro`     | `funcoes_financeiras.gerenciar` |

  O mapa comando → grupo fica centralizado em `BOT_COMMAND_GROUPS` em `src/routes/bot.ts`; um novo comando do bot só precisa de uma entrada nova ali (`bot_<comando>`), sem tocar no resto da lógica de autorização.
- `POST /api/bot/measurements` aceita quem for `admin` OU (`bot_whatsapp` E `bot_medicao`).

### Liberar ou remover alguém pelo portal

1. Abra o cadastro do usuário em **Usuários** no portal.
2. Para liberar o bot: adicione o usuário ao grupo `bot_whatsapp` e, conforme o uso, a `bot_medicao` (lançar medições) e/ou `bot_financeiro` (funções financeiras). Usuários com `admin='S'` não precisam de grupo.
3. Para remover o acesso: remova o vínculo do usuário com `bot_whatsapp` (isso já derruba o contexto) e, se quiser revogar só um comando, remova apenas `bot_medicao`/`bot_financeiro` mantendo `bot_whatsapp`.
4. Os grupos `bot_whatsapp`/`bot_medicao`/`bot_financeiro` e os vínculos migrados a partir dos grupos de tela antigos são criados por `scripts/migrate-bot-groups.mjs` (ver seção de migração abaixo); depois disso, a manutenção é manual pelo portal como qualquer outro grupo.

### Migração `scripts/migrate-bot-groups.mjs`

Cria os 3 grupos novos em `grupos` (se não existirem, copiando o formato de um documento existente da coleção) e, em `grupos_usuario`, vincula usuários ativos não-admin com telefone cadastrado que hoje teriam contexto pelas regras antigas: `bot_whatsapp`+`bot_medicao` para quem tem `medicina`/`equipe_enfermagem`/`coordenacao`; `bot_whatsapp`+`bot_financeiro` para quem tem o grupo `financeiro` ou `funcao="Diretor Financeiro"`. Idempotente — não duplica grupo nem vínculo já existente.

Execução (lê `MONGODB_URI`/`MONGODB_DBNAME` do ambiente do container):
```
docker exec lfz-api node /app/scripts/migrate-bot-groups.mjs            # dry-run, só conta
docker exec lfz-api node /app/scripts/migrate-bot-groups.mjs --apply    # grava
```
Padrão é dry-run (não grava nada). A saída é só contagens (`groupsExisting`, `groupsToCreate`/`groupsCreated`, `linksToCreate`/`linksCreated`) — nunca nomes ou telefones.
Aplicação: `git apply /var/lib/openbot/OpenBot/Shared/portal-api-bot.patch` no checkout da API (como root ou proprietário do checkout), configure o segredo fora do Git e valide com `npm run build` e testes HTTP autenticados.
Rollback: `git apply -R /var/lib/openbot/OpenBot/Shared/portal-api-bot.patch`; remova `BOT_SERVICE_TOKEN` somente depois de parar os consumidores.
