const { buscarFaturas } = require('./minhasfaturas');

// Portal novo, mesmo padrao do PJ (lib/pj.js): login por CPF + codigo da
// carteirinha, sem senha. Slug muda por regiao/operadora: interior e Hapvida
// (hapvida-saude-pf-al), capital (SP_CAPITAL) e NotreDame Intermedica
// (ndi-sp-saude-pf-al — mesmo padrao do PJ capital, ndi-sp-saude-pj-al).
const SLUG_INTERIOR = 'hapvida-saude-pf-al';
const SLUG_CAPITAL = 'ndi-sp-saude-pf-al';

// Slug errado gravado nos primeiros clientes da capital (nem abre o formulario).
const SLUGS_ANTIGOS = { 'ndi-pf-al': SLUG_CAPITAL };

// O portal pede o "Codigo do Usuario" da carteirinha (14 caracteres = contrato +
// sufixo de 3 digitos do beneficiario). O parceiro so guarda o numero do contrato
// (11 caracteres) — com ele sozinho o portal recusa, mas com qualquer sufixo
// de 3 digitos aceita e devolve as faturas do contrato (testado em 2026-10-21).
function codigoUsuario(carteirinha) {
  const c = (carteirinha || '').trim();
  return c.length === 11 ? `${c}000` : c;
}

async function buscarFaturasPF({ cpf, carteirinha, team, slug }) {
  const slugInformado = SLUGS_ANTIGOS[slug] || slug;
  const slugFinal = slugInformado || (team === 'SP_CAPITAL' ? SLUG_CAPITAL : SLUG_INTERIOR);
  return buscarFaturas({ slug: slugFinal, referenceId: cpf, customerValidation: codigoUsuario(carteirinha) });
}

module.exports = { buscarFaturasPF, SLUG_INTERIOR, SLUG_CAPITAL };
