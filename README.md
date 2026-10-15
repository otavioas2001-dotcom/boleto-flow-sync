# Boleto Flow — Sincronização

Robô que roda todo dia via GitHub Actions (sem depender de nenhum notebook ligado):
busca as faturas de cada cliente/empresa nos portais Hapvida/NotreDame e manda pro
Boleto Flow, depois dispara os lembretes de pagamento.

Não tem nenhuma senha de cliente aqui no código — tudo é buscado em tempo real do
dashboard do Boleto Flow (`PORTFOLIO_URL`) e os tokens ficam só como GitHub Secrets.

## Rodar manualmente

Vá em Actions → "Sincronizar boletos" → "Run workflow".

## Estrutura

- `servidor/sincronizar.js` — ponto de entrada, chama os módulos de `lib/` e manda os
  resultados pro Boleto Flow.
- `lib/` — automação Playwright que faz login nos portais e baixa as faturas.
- `.github/workflows/sincronizar.yml` — agendamento diário (09:00 horário de Brasília).
