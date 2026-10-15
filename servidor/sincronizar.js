const fs = require('fs');
const path = require('path');
const { buscarFaturasPJ } = require('../lib/pj');
const { buscarFaturasPJLegado } = require('../lib/pj-legado');
const { buscarFaturasPF } = require('../lib/pf');

// Portal novo exige CNPJ valido (dv correto). Empresas cadastradas por CAEPF
// (pessoa fisica com atividade economica) tem o mesmo tamanho de CNPJ mas
// nao passam nesse digito verificador — pra essas o portal novo rejeita de cara
// com "CNPJ invalido", entao usamos o portal antigo (codigo + senha).
function validaDigitoVerificadorCNPJ(cnpj) {
  const d = (cnpj || '').replace(/\D/g, '');
  if (d.length !== 14) return false;
  const calc = (base, pesos) => {
    let soma = 0;
    for (let i = 0; i < pesos.length; i++) soma += parseInt(base[i], 10) * pesos[i];
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = calc(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(d.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${d1}${d2}` === d.slice(12);
}

async function buscarFaturasEmpresa(empresa) {
  if (empresa.cnpj && validaDigitoVerificadorCNPJ(empresa.cnpj)) {
    return buscarFaturasPJ({ cnpj: empresa.cnpj, codigo: empresa.codigo, slug: empresa.slug });
  }
  if (empresa.senha) {
    return buscarFaturasPJLegado(empresa);
  }
  return { ok: false, erro: empresa.cnpj ? 'cnpj_invalido_e_sem_senha_legado' : 'faltam_credenciais' };
}

function carregarEnv(nomeArquivo) {
  const envPath = path.join(__dirname, '..', nomeArquivo || '.env');
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// Fonte da carteira: por padrao o endpoint do dashboard (GET /api/public/portfolio),
// que devolve empresas/clientes com id (uuid) do banco e a senha ja descriptografada.
// Sem PORTFOLIO_URL configurada, cai pro carteira.json local (so serve pra teste manual —
// sem id do dashboard nao da pra mandar o resultado pro ingest-invoices).
async function carregarCarteiraRemota(env) {
  const resp = await fetch(env.PORTFOLIO_URL, {
    headers: { 'x-ingest-token': env.INGEST_TOKEN },
  });
  if (!resp.ok) {
    throw new Error(`Falha ao buscar carteira remota: HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const dados = await resp.json();

  const empresas = (dados.companies || []).map(c => ({
    dashboardId: c.id,
    codigo: c.companyCode,
    cnpj: c.document || undefined,
    senha: c.password || undefined,
    slug: c.portalSlug || undefined,
    usuario: '',
  }));

  const clientes = (dados.clients || []).map(c => ({
    dashboardId: c.id,
    cpf: c.cpf,
    carteirinha: c.cardNumber,
    slug: c.portalSlug || undefined,
    team: c.team || undefined,
  }));

  return { empresas, clientes };
}

function carregarCarteiraLocal() {
  const arquivo = path.join(__dirname, '..', 'carteira.json');
  if (!fs.existsSync(arquivo)) {
    throw new Error('carteira.json nao encontrado — copie carteira.exemplo.json e preencha com dados reais (esse arquivo nao vai pro git). Ou configure PORTFOLIO_URL/INGEST_TOKEN no .env pra usar o dashboard como fonte.');
  }
  return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
}

async function carregarCarteira(env) {
  if (env.PORTFOLIO_URL && env.INGEST_TOKEN) {
    return carregarCarteiraRemota(env);
  }
  return carregarCarteiraLocal();
}

// Contrato real de POST /api/public/ingest-invoices: { targetType, targetId (uuid), invoices[] }.
// So da pra chamar quando a fatura veio de uma entidade com id do dashboard (modo remoto).
async function enviarParaIngest({ env, targetType, targetId, faturas }) {
  if (!env.INGEST_URL || !env.INGEST_TOKEN) {
    return { enviado: false, motivo: 'INGEST_URL/INGEST_TOKEN nao configurados no .env — resultado so ficou local' };
  }
  if (!targetId) {
    return { enviado: false, motivo: 'sem id do dashboard (carteira.json local nao tem uuid) — rode via PORTFOLIO_URL pra ingerir de verdade' };
  }

  const payload = {
    targetType,
    targetId,
    invoices: faturas.map(f => ({
      externalId: f.id,
      referenceMonth: (f.reference_month || '').replace('/', '-'),
      dueDate: f.due_date,
      amountCents: f.amount_cents,
      barcode: f.barcode || undefined,
      pdfBase64: f.pdfBuffer ? f.pdfBuffer.toString('base64') : undefined,
    })),
  };

  const resp = await fetch(env.INGEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingest-token': env.INGEST_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  const corpo = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { enviado: false, motivo: `HTTP ${resp.status}: ${JSON.stringify(corpo)}` };
  }
  return { enviado: true, resultado: corpo };
}

async function dispararLembretes(env) {
  if (!env.INGEST_URL || !env.INGEST_TOKEN) {
    return { enviado: false, motivo: 'INGEST_URL/INGEST_TOKEN nao configurados' };
  }
  const baseUrl = env.INGEST_URL.replace(/\/api\/public\/.*$/, '');
  try {
    const resp = await fetch(`${baseUrl}/api/public/send-reminder-emails`, {
      method: 'POST',
      headers: { 'x-ingest-token': env.INGEST_TOKEN },
    });
    const corpo = await resp.json().catch(() => null);
    return { enviado: resp.ok, http: resp.status, resultado: corpo };
  } catch (e) {
    return { enviado: false, motivo: e.message };
  }
}

async function sincronizarTudo(nomeArquivoEnv) {
  const env = carregarEnv(nomeArquivoEnv);
  const carteira = await carregarCarteira(env);
  const relatorio = { empresas: [], clientes: [], iniciadoEm: new Date().toISOString() };

  for (const empresa of carteira.empresas || []) {
    console.log(`[PJ] verificando ${empresa.codigo}...`);
    try {
      const resultado = await buscarFaturasEmpresa(empresa);
      if (!resultado.ok) {
        console.log(`[PJ] ${empresa.codigo}: erro — ${resultado.erro}`);
        relatorio.empresas.push({ codigo: empresa.codigo, ok: false, erro: resultado.erro });
        continue;
      }
      console.log(`[PJ] ${empresa.codigo}: ${resultado.faturas.length} fatura(s)`);
      const envio = await enviarParaIngest({
        env,
        targetType: 'company',
        targetId: empresa.dashboardId,
        faturas: resultado.faturas,
      });
      relatorio.empresas.push({ codigo: empresa.codigo, ok: true, faturas: resultado.faturas.length, envio });
    } catch (e) {
      console.log(`[PJ] ${empresa.codigo}: excecao — ${e.message}`);
      relatorio.empresas.push({ codigo: empresa.codigo, ok: false, erro: e.message });
    }
  }

  for (const cliente of carteira.clientes || []) {
    console.log(`[PF] verificando ${cliente.cpf}...`);
    try {
      const resultado = await buscarFaturasPF(cliente);
      if (!resultado.ok) {
        console.log(`[PF] ${cliente.cpf}: erro — ${resultado.erro}`);
        relatorio.clientes.push({ cpf: cliente.cpf, ok: false, erro: resultado.erro });
        continue;
      }
      console.log(`[PF] ${cliente.cpf}: ${resultado.faturas.length} fatura(s)`);
      const envio = await enviarParaIngest({
        env,
        targetType: 'client',
        targetId: cliente.dashboardId,
        faturas: resultado.faturas,
      });
      relatorio.clientes.push({ cpf: cliente.cpf, ok: true, faturas: resultado.faturas.length, envio });
    } catch (e) {
      console.log(`[PF] ${cliente.cpf}: excecao — ${e.message}`);
      relatorio.clientes.push({ cpf: cliente.cpf, ok: false, erro: e.message });
    }
  }

  console.log('\nDisparando lembretes de pagamento...');
  relatorio.lembretes = await dispararLembretes(env);
  console.log('Lembretes:', JSON.stringify(relatorio.lembretes));

  relatorio.finalizadoEm = new Date().toISOString();
  return relatorio;
}

if (require.main === module) {
  const nomeArquivoEnv = process.argv[2];
  sincronizarTudo(nomeArquivoEnv)
    .then(relatorio => {
      console.log('\n--- Relatorio ---');
      console.log(JSON.stringify(relatorio, null, 2));
    })
    .catch(e => {
      console.error('Falha na sincronizacao:', e);
      process.exit(1);
    });
}

module.exports = { sincronizarTudo };
