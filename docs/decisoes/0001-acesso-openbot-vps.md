# 0001 — Acesso dos agentes OpenBot à VPS
- Data: 2026-10-28
- Status: aceita
- Decisor: Ayrton

## Contexto
Os agentes OpenBot rodam como usuário `openbot` (não root) e precisam mexer nos apps em `/srv/apps` e operar os containers.

## Opções
- **A. Grupo `docker`:** simples, mas na prática equivale a root na VPS.
- **B. Grupo `apps` nas pastas + script fixo via sudo:** lista fechada de ações, `.env` continua só do root, fácil de revogar. Ainda dá para escalar editando o compose, e o controle disso é a regra de aprovação de deploy.
- **C. Docker rootless:** isolamento mais forte, mas exige migrar os containers, com risco de downtime.

## Decisão
Opção B.
- Grupo `apps` (membro: `openbot`), com escrita e setgid em `/srv/apps`.
- `.env` como `root:root 600`.
- `/usr/local/sbin/openbot-app <app> <ps|logs|restart|up>`, com `NOPASSWD` só para esse script (`/etc/sudoers.d/openbot-app`).

## Consequências
- `ps` e `logs` são livres. `restart` e `up` são deploy e exigem aprovação do Ayrton.
- Para incluir um app novo, editar o `case` do script como root.
- Script corrigido para `-f compose.prod.yaml -f compose.hostinger.yaml` (2026-10-28).
- Para revogar: `gpasswd -d openbot apps` e `rm /etc/sudoers.d/openbot-app`.
