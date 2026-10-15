const { buscarFaturas } = require('./minhasfaturas');

// Portal novo, mesmo padrao do PJ (lib/pj.js): login por CPF + codigo da
// carteirinha, sem senha. Slug muda por regiao/operadora: interior e Hapvida
// (hapvida-saude-pf-al), capital (SP_CAPITAL) e NotreDame Intermedica (ndi-pf-al).
const SLUG_INTERIOR = 'hapvida-saude-pf-al';
const SLUG_CAPITAL = 'ndi-pf-al';

async function buscarFaturasPF({ cpf, carteirinha, team, slug }) {
  const slugFinal = slug || (team === 'SP_CAPITAL' ? SLUG_CAPITAL : SLUG_INTERIOR);
  return buscarFaturas({ slug: slugFinal, referenceId: cpf, customerValidation: carteirinha });
}

module.exports = { buscarFaturasPF, SLUG_INTERIOR, SLUG_CAPITAL };
