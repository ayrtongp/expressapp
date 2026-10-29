# API interna do bot
Configure `BOT_SERVICE_TOKEN` na API e no bot. Nunca registre ou versione o valor.
Todas as rotas exigem `Authorization: Bearer <BOT_SERVICE_TOKEN>`.
- `GET /api/bot/context?phone=<E164>`: retorna `EmployeeContext` ou `null`. Autoriza somente usuários ativos: `usuario.admin=S` concede gestão de usuários; `usuario.funcao="Diretor Financeiro"` concede funções financeiras; o grupo real `financeiro` também concede funções financeiras; `medicina`, `equipe_enfermagem` e `coordenacao` concedem medição. Não há campo/valor confirmado para `dono`.
  Capacidades: `admin` → `usuarios.gerenciar` e `funcoes_financeiras.gerenciar`; `Diretor Financeiro`/grupo `financeiro` → `funcoes_financeiras.gerenciar`; grupos clínicos → `medicao_avulsa.criar`.
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
Aplicação: `git apply /var/lib/openbot/OpenBot/Shared/portal-api-bot.patch` no checkout da API (como root ou proprietário do checkout), configure o segredo fora do Git e valide com `npm run build` e testes HTTP autenticados.
Rollback: `git apply -R /var/lib/openbot/OpenBot/Shared/portal-api-bot.patch`; remova `BOT_SERVICE_TOKEN` somente depois de parar os consumidores.
