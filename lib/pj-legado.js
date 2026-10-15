const { chromium } = require('playwright');

// Mesma categoria (Mensalidade/Coparticipação) do portal novo — ver lib/minhasfaturas.js.
function normalizarCategoria(valor) {
  if (!valor) return null;
  const limpo = valor.toLowerCase();
  if (limpo.includes('coparticip')) return 'coparticipacao';
  if (limpo.includes('mensalidade')) return 'mensalidade';
  return null;
}

function extrairCategoria(fatura) {
  const campo = (fatura.extra_params || []).find(p => p.key === 'description');
  return normalizarCategoria(campo?.value);
}

// FLUXO ANTIGO/FALLBACK — a Hapvida esta migrando o login PJ pro portal novo
// (minhasfaturas.hapvida.com.br/hapvida-saude-pj-al, ver lib/pj.js). Mantido aqui
// caso alguma empresa ainda so funcione pelo portal velho durante a transicao.
// O portal WebHap usa a stack PL/SQL antiga (webNewBoletoEmpresa) so pro login;
// a listagem/download de faturas de fato roda num widget React da Bemobi dentro de um iframe.
async function buscarFaturasPJLegado({ codigo, usuario = '', senha }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    let dadosFaturas = null;
    page.on('response', async (res) => {
      if (res.url().includes('invoicescheckout.bemobi.com/api/invoices') && res.request().method() === 'POST') {
        try { dadosFaturas = await res.json(); } catch (e) { /* ignora corpo nao-json */ }
      }
    });

    await page.goto('https://www.hapvida.com.br/pls/webhap/webNewBoletoEmpresa.Login', { waitUntil: 'networkidle', timeout: 60000 });
    await page.fill('input[name="pCodigo"]', codigo);
    await page.fill('input[name="pNm_Login"]', usuario);
    await page.fill('input[name="pSenha"]', senha);

    // Popup "EVITE FRAUDE DIGITAL" abre por cima do botao de login e bloqueia o clique.
    const fecharAviso = page.locator('.ui-dialog-buttonpane button:has-text("Fechar")');
    if (await fecharAviso.isVisible().catch(() => false)) {
      await fecharAviso.click();
      await page.waitForTimeout(300);
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => null),
      page.click('#btn_reajuste1'),
    ]);

    if (page.url().includes('webNewBoletoEmpresa.Login')) {
      return { ok: false, erro: 'login_falhou' };
    }

    await page.waitForTimeout(3000);

    if (!dadosFaturas) {
      return { ok: false, erro: 'api_nao_capturada' };
    }

    if (dadosFaturas.message) {
      return { ok: false, erro: dadosFaturas.message };
    }

    const faturas = dadosFaturas.invoices || [];
    const resultado = {
      ok: true,
      contrato: dadosFaturas.contract,
      nomeCliente: dadosFaturas.corporate?.corporate_name || null,
      faturas: [],
    };

    if (faturas.length > 0) {
      const frame = page.frame({ url: /bemobi/ });
      // Usa ElementHandles (nao locator.nth) porque a lista pode re-renderizar entre
      // cliques — nth() re-consulta o DOM a cada acao e desalinha o indice com a fatura certa.
      const handles = await frame.$$('button[aria-label="Baixar fatura em PDF"]');

      for (let i = 0; i < handles.length; i++) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
          handles[i].click(),
        ]);

        const idNaUrl = download ? require('path').basename(new URL(download.url()).pathname).split('_')[0] : null;
        const fatura = faturas.find(f => f.id === idNaUrl) || faturas[i];
        let pdfBuffer = null;
        if (download) {
          const stream = await download.createReadStream();
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          pdfBuffer = Buffer.concat(chunks);
        } else {
          console.warn(`[PJ] aviso: download nao disparou pra fatura indice ${i} (id esperado ${fatura?.id})`);
        }

        resultado.faturas.push({
          id: fatura.id,
          reference_month: fatura.reference_month,
          due_date: fatura.due_date,
          amount_cents: fatura.amount?.value ?? null,
          barcode: fatura.barcode || null,
          overdue: !!fatura.overdue,
          category: extrairCategoria(fatura),
          pdfBuffer,
        });

        await page.waitForTimeout(300);
      }

      if (handles.length !== faturas.length) {
        console.warn(`[PJ] aviso: API retornou ${faturas.length} fatura(s) mas so achou ${handles.length} botao(oes) de download na tela`);
      }
    }

    return resultado;
  } finally {
    await browser.close();
  }
}

module.exports = { buscarFaturasPJLegado };
