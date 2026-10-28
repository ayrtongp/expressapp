# API interna do bot
Configure `BOT_SERVICE_TOKEN` na API e no bot. Nunca registre ou versione o valor.
Todas as rotas exigem `Authorization: Bearer <BOT_SERVICE_TOKEN>`.
- `GET /api/bot/context?phone=<E164>`: retorna `EmployeeContext` ou `null`. Autoriza somente usuários ativos: `usuario.admin=S` concede gestão de usuários; `usuario.funcao="Diretor Financeiro"` concede funções financeiras; o grupo real `financeiro` também concede funções financeiras; `medicina`, `equipe_enfermagem` e `coordenacao` concedem medição. Não há campo/valor confirmado para `dono`.
  Capacidades: `admin` → `usuarios.gerenciar` e `funcoes_financeiras.gerenciar`; `Diretor Financeiro`/grupo `financeiro` → `funcoes_financeiras.gerenciar`; grupos clínicos → `medicao_avulsa.criar`.
- `GET /api/bot/residents?query=<texto>` e `GET /api/bot/residents`: retorna `{id,name}[]` de `patient` ativos.
- `POST /api/bot/measurements`: aceita `CreateMeasurementInput`; grava em `measurement_session` e `measurement`, usando `source_type=manual` (pressão no formato `sistólica/diastólica`). É idempotente por paciente, registrador e timestamp.
Respostas: 401 sem token, 403 token inválido/permissão insuficiente, 400 entrada inválida, 404 registro inexistente e 500 com mensagem genérica.
Aplicação: `git apply /var/lib/openbot/OpenBot/Shared/portal-api-bot.patch` no checkout da API (como root ou proprietário do checkout), configure o segredo fora do Git e valide com `npm run build` e testes HTTP autenticados.
Rollback: `git apply -R /var/lib/openbot/OpenBot/Shared/portal-api-bot.patch`; remova `BOT_SERVICE_TOKEN` somente depois de parar os consumidores.
