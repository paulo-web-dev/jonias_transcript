"use strict";

const puppeteer = require("puppeteer-core");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageBreak,
} = require("docx");
const { renderizarMarkdown, escaparHtml } = require("./js/markdown.js");

// ---------- Utilitários ----------

function formatarDuracao(segundos) {
  const s = Math.max(0, Math.round(segundos || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const seg = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m > 0) return `${m}min ${String(seg).padStart(2, "0")}s`;
  return `${seg}s`;
}

function formatarData(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? String(iso)
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

function formatarHora(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? ""
    : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function nomeDeArquivo(nome, extensao) {
  const base =
    String(nome)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "aula";
  return `${base}.${extensao}`;
}

// ---------- PDF (puppeteer-core + Chrome instalado) ----------

let navegadorPromise = null;

async function obterNavegador() {
  if (!navegadorPromise) {
    navegadorPromise = puppeteer
      .launch({ channel: "chrome", headless: true })
      .catch((err) => {
        navegadorPromise = null; // permite nova tentativa
        throw err;
      });
  }
  return navegadorPromise;
}

function montarHtmlPdf(aula, anotacoes) {
  const linhasAnotacoes = anotacoes
    .map(
      (a) => `
        <div class="anotacao">
          <span class="hora">${escaparHtml(formatarHora(a.timestamp))}</span>
          <span>${escaparHtml(a.texto)}</span>
        </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #232945; font-size: 11pt; line-height: 1.6; }

  .capa {
    height: 100vh;
    background: linear-gradient(150deg, #1a1f36 0%, #0b0e17 70%);
    color: #e8ecf4;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 60px 70px;
    page-break-after: always;
  }
  .capa .marca { font-size: 15pt; font-weight: 800; letter-spacing: 1px; color: #e8ecf4; margin-bottom: 28px; }
  .capa .marca .ia, .rodape-gerado .ia { color: #38d6e0; }
  .capa h1 { font-size: 30pt; line-height: 1.25; margin-bottom: 32px; }
  .capa .meta { font-size: 12pt; color: #aab2c8; display: flex; flex-direction: column; gap: 6px; }
  .capa .barra { width: 90px; height: 5px; border-radius: 3px; background: linear-gradient(90deg, #6c7bff, #38d6e0); margin-bottom: 28px; }

  .conteudo { padding: 52px 60px; }
  .conteudo h2 { font-size: 19pt; color: #1a1f36; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 3px solid #6c7bff; }
  .conteudo h3 { font-size: 14pt; color: #4653c8; margin: 22px 0 8px; }
  .conteudo h4 { font-size: 12pt; color: #1a1f36; margin: 16px 0 6px; }
  .conteudo p { margin-bottom: 8px; }
  .conteudo ul { margin: 6px 0 12px 0; padding-left: 20px; }
  .conteudo li { margin-bottom: 5px; }
  .conteudo strong { color: #4653c8; }
  .conteudo code { background: #eef0fb; padding: 1px 5px; border-radius: 4px; font-size: 10pt; }

  .secao-anotacoes { page-break-before: always; }
  .anotacao {
    display: flex;
    gap: 14px;
    padding: 9px 12px;
    border-left: 3px solid #38d6e0;
    background: #f5f7ff;
    border-radius: 0 8px 8px 0;
    margin-bottom: 8px;
    page-break-inside: avoid;
  }
  .anotacao .hora { color: #6c7bff; font-weight: 600; white-space: nowrap; font-size: 10pt; padding-top: 1px; }
  .vazio { color: #8b93a7; font-style: italic; }
  .rodape-gerado {
    margin-top: 36px;
    padding-top: 14px;
    border-top: 1px solid #e2e5f0;
    color: #8b93a7;
    font-size: 9pt;
    text-align: center;
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="capa">
    <div class="marca">● jon<span class="ia">IA</span>s</div>
    <div class="barra"></div>
    <h1>${escaparHtml(aula.nome)}</h1>
    <div class="meta">
      <span>📅 ${escaparHtml(formatarData(aula.data_criacao))}</span>
      <span>⏱ Duração: ${escaparHtml(formatarDuracao(aula.duracao))}</span>
      <span>📝 ${anotacoes.length} anotação(ões) geradas</span>
    </div>
  </div>

  <div class="conteudo">
    ${
      aula.resumo_md
        ? renderizarMarkdown(aula.resumo_md)
        : '<h2>Resumo</h2><p class="vazio">Nenhum resumo foi gerado para esta aula.</p>'
    }

    <div class="secao-anotacoes">
      <h2>Anotações da aula</h2>
      ${linhasAnotacoes || '<p class="vazio">Nenhuma anotação registrada.</p>'}
    </div>

    <p class="rodape-gerado">Gerado por jon<span class="ia">IA</span>s — Assistente de Aulas</p>
  </div>
</body>
</html>`;
}

async function gerarPdf(aula, anotacoes) {
  const navegador = await obterNavegador();
  const pagina = await navegador.newPage();
  try {
    await pagina.setContent(montarHtmlPdf(aula, anotacoes), { waitUntil: "load" });
    return await pagina.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  } finally {
    await pagina.close();
  }
}

// ---------- DOCX ----------

// Converte texto com **negrito**, *itálico* e `código` em TextRuns
function runsDeLinha(texto, extra = {}) {
  const runs = [];
  const partes = texto.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  for (const p of partes) {
    if (!p) continue;
    if (p.startsWith("**") && p.endsWith("**")) {
      runs.push(new TextRun({ text: p.slice(2, -2), bold: true, ...extra }));
    } else if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
      runs.push(new TextRun({ text: p.slice(1, -1), italics: true, ...extra }));
    } else if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      runs.push(new TextRun({ text: p.slice(1, -1), font: "Consolas", ...extra }));
    } else {
      runs.push(new TextRun({ text: p, ...extra }));
    }
  }
  return runs;
}

function paragrafosDoMarkdown(md) {
  const paragrafos = [];
  for (const linha of String(md).split(/\r?\n/)) {
    const l = linha.trim();
    if (!l) continue;
    if (l.startsWith("### ")) {
      paragrafos.push(
        new Paragraph({ children: runsDeLinha(l.slice(4)), heading: HeadingLevel.HEADING_3 })
      );
    } else if (l.startsWith("## ")) {
      paragrafos.push(
        new Paragraph({ children: runsDeLinha(l.slice(3)), heading: HeadingLevel.HEADING_2 })
      );
    } else if (l.startsWith("# ")) {
      paragrafos.push(
        new Paragraph({ children: runsDeLinha(l.slice(2)), heading: HeadingLevel.HEADING_1 })
      );
    } else if (/^[-*] /.test(l)) {
      paragrafos.push(
        new Paragraph({ children: runsDeLinha(l.slice(2)), bullet: { level: 0 } })
      );
    } else {
      paragrafos.push(new Paragraph({ children: runsDeLinha(l) }));
    }
  }
  return paragrafos;
}

async function gerarDocx(aula, anotacoes) {
  const filhos = [
    new Paragraph({
      children: [
        new TextRun({ text: "jon", bold: true, size: 28 }),
        new TextRun({ text: "IA", bold: true, color: "38D6E0", size: 28 }),
        new TextRun({ text: "s", bold: true, size: 28 }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 2400, after: 300 },
    }),
    new Paragraph({
      children: [new TextRun({ text: aula.nome, bold: true, size: 56 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `${formatarData(aula.data_criacao)}  •  Duração: ${formatarDuracao(aula.duracao)}  •  ${anotacoes.length} anotação(ões)`,
          color: "666E85",
          size: 22,
        }),
      ],
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  if (aula.resumo_md) {
    filhos.push(...paragrafosDoMarkdown(aula.resumo_md));
  } else {
    filhos.push(
      new Paragraph({ text: "Resumo", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({
        children: [new TextRun({ text: "Nenhum resumo foi gerado para esta aula.", italics: true })],
      })
    );
  }

  filhos.push(
    new Paragraph({
      text: "Anotações da aula",
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
    })
  );
  if (anotacoes.length === 0) {
    filhos.push(
      new Paragraph({
        children: [new TextRun({ text: "Nenhuma anotação registrada.", italics: true })],
      })
    );
  } else {
    for (const a of anotacoes) {
      filhos.push(
        new Paragraph({
          children: [
            new TextRun({ text: `[${formatarHora(a.timestamp)}] `, bold: true, color: "4653C8" }),
            new TextRun(a.texto),
          ],
          bullet: { level: 0 },
        })
      );
    }
  }

  filhos.push(
    new Paragraph({
      children: [
        new TextRun({ text: "Gerado por jon", color: "8B93A7", size: 18 }),
        new TextRun({ text: "IA", color: "38D6E0", size: 18 }),
        new TextRun({ text: "s — Assistente de Aulas", color: "8B93A7", size: 18 }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 600 },
    })
  );

  const documento = new Document({
    creator: "jonIAs",
    title: aula.nome,
    sections: [{ children: filhos }],
  });

  return Packer.toBuffer(documento);
}

module.exports = { gerarPdf, gerarDocx, nomeDeArquivo };
