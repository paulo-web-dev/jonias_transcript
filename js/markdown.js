"use strict";

// Conversor Markdown -> HTML minimalista, usado no navegador (modal e tela de
// visualização) e no servidor (template do PDF). Sem dependências de DOM.

function escaparHtml(texto) {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderizarMarkdown(md) {
  const inline = (t) =>
    t
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>");

  const linhas = escaparHtml(md).split(/\r?\n/);
  let html = "";
  let emLista = false;
  const fecharLista = () => {
    if (emLista) {
      html += "</ul>";
      emLista = false;
    }
  };

  for (const linha of linhas) {
    const l = linha.trim();
    if (!l) {
      fecharLista();
      continue;
    }
    if (l.startsWith("### ")) {
      fecharLista();
      html += `<h4>${inline(l.slice(4))}</h4>`;
    } else if (l.startsWith("## ")) {
      fecharLista();
      html += `<h3>${inline(l.slice(3))}</h3>`;
    } else if (l.startsWith("# ")) {
      fecharLista();
      html += `<h2>${inline(l.slice(2))}</h2>`;
    } else if (/^[-*] /.test(l)) {
      if (!emLista) {
        html += "<ul>";
        emLista = true;
      }
      html += `<li>${inline(l.slice(2))}</li>`;
    } else {
      fecharLista();
      html += `<p>${inline(l)}</p>`;
    }
  }
  fecharLista();
  return html;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderizarMarkdown, escaparHtml };
} else {
  window.MarkdownAula = { renderizarMarkdown, escaparHtml };
}
