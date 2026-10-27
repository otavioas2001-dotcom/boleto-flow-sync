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
// Em 24/10 (HTTP 401 — o endpoint responde 401 tambem quando a consulta do token
// falha no banco) e 25/10 (fetch failed) o servidor oscilou bem na hora e a rodada
// do Joao inteira se perdeu. Tenta 4 vezes, com 2 min entre as tentativas.
async function buscarCarteiraComRetentativa(env, tentativas = 4, esperaMs = 120000) {
  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const resp = await fetch(env.PORTFOLIO_URL, {
        headers: { 'x-ingest-token': env.INGEST_TOKEN },
        signal: AbortSignal.timeout(120000),
      });
      if (resp.ok) return await resp.json();
      ultimoErro = new Error(`Falha ao buscar carteira remota: HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    } catch (e) {
      ultimoErro = new Error(`Falha ao buscar carteira remota: ${e.message}`);
    }
    console.log(`[carteira] tentativa ${i}/${tentativas} falhou — ${ultimoErro.message}`);
    if (i < tentativas) await new Promise(r => setTimeout(r, esperaMs));
  }
  throw ultimoErro;
}

async function carregarCarteiraRemota(env) {
  const dados = await buscarCarteiraComRetentativa(env);

  // accessType 'none' = capital + CAEPF: nao existe portal de boleto pra elas, o
  // Boleto Flow so manda lembrete recorrente pelo dia do vencimento. Tentar o portal
  // so gerava pendencia falsa ("precisa de senha") na aba Verificacoes.
  const empresas = (dados.companies || []).filter(c => c.accessType !== 'none').map(c => ({
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
      category: f.category || undefined,
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

// Traduz o erro cru do scraper pro codigo de motivo que a aba Historico →
// Verificacoes do Boleto Flow sabe explicar pro cliente (src/lib/sync-reasons.ts).
function classificarErro(erro) {
  const msg = String(erro || '');
  if (/error status for invoice listing/i.test(msg)) return 'portal_nao_encontrou';
  if (msg === 'cnpj_invalido_e_sem_senha_legado') return 'falta_senha_portal_antigo';
  if (msg === 'faltam_credenciais') return 'faltam_dados_acesso';
  if (msg === 'login_falhou') return 'login_recusado';
  if (msg === 'api_nao_capturada' || /timeout|net::|navigation|reading 'fill'|Target (page|closed)/i.test(msg)) return 'portal_instavel';
  return 'nao_verificado';
}

// POST /api/public/report-sync: 1 relatorio por rodada, com os totais e so as
// pendencias (o que deu certo ja aparece nas faturas, nao precisa listar).
async function enviarRelatorio(env, relatorio, fatalError) {
  if (!env.INGEST_URL || !env.INGEST_TOKEN) return { enviado: false, motivo: 'INGEST_URL/INGEST_TOKEN nao configurados' };
  const baseUrl = env.INGEST_URL.replace(/\/api\/public\/.*$/, '');
  const todos = [...relatorio.empresas, ...relatorio.clientes];
  const payload = {
    startedAt: relatorio.iniciadoEm,
    finishedAt: new Date().toISOString(),
    fatalError: fatalError || null,
    totals: {
      companiesChecked: relatorio.empresas.length,
      clientsChecked: relatorio.clientes.length,
      ok: todos.filter(r => r.ok).length,
      newInvoices: todos.reduce((soma, r) => soma + (r.envio?.resultado?.newInvoices || 0), 0),
    },
    items: todos.filter(r => !r.ok).map(r => ({
      targetType: r.targetType,
      targetId: r.targetId || null,
      reasonCode: r.motivo,
      detail: String(r.erro || '').slice(0, 5000),
    })),
  };
  try {
    const resp = await fetch(`${baseUrl}/api/public/report-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': env.INGEST_TOKEN },
      body: JSON.stringify(payload),
    });
    const corpo = await resp.json().catch(() => null);
    return { enviado: resp.ok, http: resp.status, resultado: corpo };
  } catch (e) {
    return { enviado: false, motivo: e.message };
  }
}

// Registra o resultado de 1 empresa/cliente no relatorio. Erro do portal ou
// falha ao gravar no ingest viram pendencia (ok: false) com codigo de motivo.
function registrar(lista, base, { erro, faturas, envio }) {
  if (erro) {
    lista.push({ ...base, ok: false, erro, motivo: classificarErro(erro) });
  } else if (envio && !envio.enviado && base.targetId) {
    lista.push({ ...base, ok: false, faturas, envio, erro: envio.motivo, motivo: 'erro_ao_salvar' });
  } else {
    lista.push({ ...base, ok: true, faturas, envio });
  }
}

async function sincronizarTudo(nomeArquivoEnv) {
  const env = carregarEnv(nomeArquivoEnv);
  const relatorio = { empresas: [], clientes: [], iniciadoEm: new Date().toISOString() };

  let carteira;
  try {
    carteira = await carregarCarteira(env);
  } catch (e) {
    // Sem carteira nao da pra verificar ninguem — avisa o painel que a rodada falhou inteira.
    relatorio.relatorioPainel = await enviarRelatorio(env, relatorio, e.message);
    throw e;
  }

  for (const empresa of carteira.empresas || []) {
    console.log(`[PJ] verificando ${empresa.codigo}...`);
    const base = { codigo: empresa.codigo, targetType: 'company', targetId: empresa.dashboardId };
    try {
      const resultado = await buscarFaturasEmpresa(empresa);
      if (!resultado.ok) {
        console.log(`[PJ] ${empresa.codigo}: erro — ${resultado.erro}`);
        registrar(relatorio.empresas, base, { erro: resultado.erro });
        continue;
      }
      console.log(`[PJ] ${empresa.codigo}: ${resultado.faturas.length} fatura(s)`);
      const envio = await enviarParaIngest({
        env,
        targetType: 'company',
        targetId: empresa.dashboardId,
        faturas: resultado.faturas,
      });
      registrar(relatorio.empresas, base, { faturas: resultado.faturas.length, envio });
    } catch (e) {
      console.log(`[PJ] ${empresa.codigo}: excecao — ${e.message}`);
      registrar(relatorio.empresas, base, { erro: e.message });
    }
  }

  for (const cliente of carteira.clientes || []) {
    console.log(`[PF] verificando ${cliente.cpf}...`);
    const base = { cpf: cliente.cpf, targetType: 'client', targetId: cliente.dashboardId };
    try {
      const resultado = await buscarFaturasPF(cliente);
      if (!resultado.ok) {
        console.log(`[PF] ${cliente.cpf}: erro — ${resultado.erro}`);
        registrar(relatorio.clientes, base, { erro: resultado.erro });
        continue;
      }
      console.log(`[PF] ${cliente.cpf}: ${resultado.faturas.length} fatura(s)`);
      const envio = await enviarParaIngest({
        env,
        targetType: 'client',
        targetId: cliente.dashboardId,
        faturas: resultado.faturas,
      });
      registrar(relatorio.clientes, base, { faturas: resultado.faturas.length, envio });
    } catch (e) {
      console.log(`[PF] ${cliente.cpf}: excecao — ${e.message}`);
      registrar(relatorio.clientes, base, { erro: e.message });
    }
  }

  console.log('\nDisparando lembretes de pagamento...');
  relatorio.lembretes = await dispararLembretes(env);
  console.log('Lembretes:', JSON.stringify(relatorio.lembretes));

  console.log('\nEnviando relatorio da verificacao pro painel...');
  relatorio.relatorioPainel = await enviarRelatorio(env, relatorio);
  console.log('Relatorio:', JSON.stringify(relatorio.relatorioPainel));

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
