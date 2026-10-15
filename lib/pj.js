const { buscarFaturas } = require('./minhasfaturas');

// Portal novo (substitui o antigo webNewBoletoEmpresa — ver lib/pj-legado.js).
// Login por CNPJ (so numeros) + codigo da empresa (5 digitos), sem senha.
// Slug muda por regiao/operadora: interior e Hapvida (hapvida-saude-pj-al),
// capital (SP_CAPITAL) e NotreDame Intermedica (ndi-sp-saude-pj-al) — confirmado
// com dados reais, empresas CAEPF nao tem portal nenhum (nem aqui nem la).
const SLUG_INTERIOR = 'hapvida-saude-pj-al';
const SLUG_CAPITAL = 'ndi-sp-saude-pj-al';

async function buscarFaturasPJ({ cnpj, codigo, team, slug }) {
  const slugFinal = slug || (team === 'SP_CAPITAL' ? SLUG_CAPITAL : SLUG_INTERIOR);
  return buscarFaturas({ slug: slugFinal, referenceId: cnpj, customerValidation: codigo });
}

module.exports = { buscarFaturasPJ, SLUG_INTERIOR, SLUG_CAPITAL };
