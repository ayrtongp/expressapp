# STATUS — API Lar Felizidade (expressapp)
Atualizado: 2026-10-28

O status geral do projeto fica em `ayrtongp/larfelizidademarica` → `docs/STATUS.md`.

## Problemas
- A produção roda de `chore/droplet-migration`, que ainda não teve merge em `main`.
- O `compose.hostinger.yaml` (override de produção) está só na VPS, sem versionamento.
- Script `openbot-app` já usa os dois composes (corrigido em 2026-10-28).
- Não há testes, e o README é o do template "bezkoder".

## Produção
- VPS `/srv/apps/lar-felizidade-api`, container `lfz-api` em `127.0.0.1:8080`, atrás do Caddy.
- Compose: `compose.prod.yaml` + `compose.hostinger.yaml`.
