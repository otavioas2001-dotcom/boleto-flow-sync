const { chromium } = require('playwright');

// Motor compartilhado do portal novo (minhasfaturas.hapvida.com.br), usado tanto
// pro fluxo PF (CPF + carteirinha) quanto pro fluxo PJ novo (CNPJ + codigo da empresa).
// O formulario de busca vive num iframe same-site (.../search); o "reCAPTCHA" ali
// e so um checkbox estilizado da propria Hapvida/Bemobi, sem verificacao real do Google.
async function buscarFaturas({ slug, referenceId, customerValidation }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    let dadosFaturas = null;
    page.on('response', async (res) => {
      if (res.url().includes('minhasfaturas.hapvida.com.br/api/invoices') && res.request().method() === 'POST') {
        try { dadosFaturas = await res.json(); } catch (e) { /* ignora corpo nao-json */ }
      }
    });

    await page.goto(`https://minhasfaturas.hapvida.com.br/${slug}`, { waitUntil: 'networkidle', timeout: 60000 });

    const frame = page.frame({ url: /minhasfaturas.*\/search/ });
    await frame.fill('#search-field-reference_id', referenceId);
    await frame.fill('#search-field-customer_validation', customerValidation);
    await frame.locator('input[type="checkbox"]').check();

    const botaoContinuar = frame.locator('button:has-text("Continuar")');
    await botaoContinuar.waitFor({ state: 'attached' });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => null),
      botaoContinuar.click(),
    ]);

    await page.waitForTimeout(2000);

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
      nomeCliente: dadosFaturas.customer?.name || null,
      faturas: [],
    };

    if (faturas.length > 0) {
      // Usa ElementHandles (nao locator.nth) porque a lista pode re-renderizar entre
      // cliques — nth() re-consulta o DOM a cada acao e desalinha o indice com a fatura certa.
      const handles = await page.$$('button[aria-label="Baixar fatura em PDF"]');

      for (let i = 0; i < handles.length; i++) {
        // O download as vezes nao dispara na 1a tentativa (PDF demora a gerar no
        // servidor da Hapvida, ou o clique nao "pega" com a pagina ainda assentando).
        // Tenta de novo antes de desistir — sem isso a fatura vai pro banco sem PDF
        // e o link do lembrete por e-mail sai vazio.
        let download = null;
        for (let tentativa = 1; tentativa <= 2 && !download; tentativa++) {
          [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
            handles[i].click(),
          ]);
          if (!download && tentativa < 2) {
            console.warn(`[${slug}] aviso: download nao disparou pra fatura indice ${i} na tentativa ${tentativa}, tentando de novo...`);
            await page.waitForTimeout(1000);
          }
        }

        const idNaUrl = download ? require('path').basename(new URL(download.url()).pathname).split('_')[0] : null;
        const fatura = faturas.find(f => f.id === idNaUrl) || faturas[i];
        let pdfBuffer = null;
        if (download) {
          const stream = await download.createReadStream();
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          pdfBuffer = Buffer.concat(chunks);
        } else {
          console.warn(`[${slug}] aviso: download nao disparou pra fatura indice ${i} apos 2 tentativas (id esperado ${fatura?.id})`);
        }

        resultado.faturas.push({
          id: fatura.id,
          reference_month: fatura.reference_month,
          due_date: fatura.due_date,
          amount_cents: fatura.amount?.value ?? null,
          barcode: fatura.barcode || null,
          overdue: !!fatura.overdue,
          pdfBuffer,
        });

        await page.waitForTimeout(300);
      }

      if (handles.length !== faturas.length) {
        console.warn(`[${slug}] aviso: API retornou ${faturas.length} fatura(s) mas so achou ${handles.length} botao(oes) de download na tela`);
      }
    }

    return resultado;
  } finally {
    await browser.close();
  }
}

module.exports = { buscarFaturas };
